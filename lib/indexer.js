
const flatten = require('lodash.flatten')
const anymatch = require('anymatch')
const LevelUtil = require('./util-level')
const {debug, veryDebug, lock, checkoutArchive} = require('./util')

// exported api
// =

exports.addArchive = async function (db, archive, {watch}) {
  veryDebug('Indexer.addArchive', archive.url, {watch})

  // store whether is writable
  var info = await archive.getInfo()
  archive.isWritable = info.isOwner

  // process the archive
  await (
    indexArchive(db, archive)
      .then(() => {
        if (watch) exports.watchArchive(db, archive)
      })
      .catch(e => onFailInitialIndex(e, db, archive, {watch}))
  )
}

exports.removeArchive = async function (db, archive) {
  veryDebug('Indexer.removeArchive', archive.url)
  await unindexArchive(db, archive)
  exports.unwatchArchive(db, archive)
}

exports.watchArchive = async function (db, archive) {
  veryDebug('Indexer.watchArchive', archive.url)
  if (archive.fileEvents) {
    console.error('watchArchive() called on archive that already is being watched', archive.url)
    return
  }
  if (archive._loadPromise) {
    // HACK node-dat-archive fix
    // Because of a weird API difference btwn node-dat-archive and beaker's DatArchive...
    // ...the event-stream methods need await _loadPromise
    // -prf
    await archive._loadPromise
  }
  archive.fileEvents = archive.watch(db._tableFilePatterns)
  // autodownload all changes to the watched files
  archive.fileEvents.addEventListener('invalidated', ({path}) => archive.download(path))
  // autoindex on changes
  // TODO debounce!!!!
  archive.fileEvents.addEventListener('changed', ({path}) => {
    indexArchive(db, archive)
  })
}

exports.unwatchArchive = function (db, archive) {
  veryDebug('Indexer.unwatchArchive', archive.url)
  if (archive.fileEvents) {
    archive.fileEvents.close()
    archive.fileEvents = null
  }
}

exports.resetOutdatedIndexes = async function (db, neededRebuilds) {
  if (neededRebuilds.length === 0) {
    return false
  }
  debug(`Indexer.resetOutdatedIndexes need to rebuild ${neededRebuilds.length} tables`)
  veryDebug('Indexer.resetOutdatedIndexes tablesToRebuild', neededRebuilds)

  // clear tables
  // TODO go per-table
  const tables = db.tables
  for (let i = 0; i < tables.length; i++) {
    let table = tables[i]
    veryDebug('clearing', table.name)
    // clear indexed data
    await LevelUtil.clear(table.level)
  }

  // reset meta records
  var promises = []
  await LevelUtil.each(db._indexMetaLevel, indexMeta => {
    indexMeta.version = 0
    promises.push(db._indexMetaLevel.put(indexMeta.url, indexMeta))
  })
  await Promise.all(promises)

  return true
}

// figure how what changes need to be processed
// then update the indexes
async function indexArchive (db, archive) {
  debug('Indexer.indexArchive', archive.url)
  var release = await lock(`index:${archive.url}`)
  try {
    // sanity check
    if (!db.isOpen && !db.isBeingOpened) {
      return
    }
    if (!db.level) {
      return console.log('indexArchive called on corrupted db')
    }

    // fetch the current state of the archive's index
    var [indexMeta, archiveMeta] = await Promise.all([
      db._indexMetaLevel.get(archive.url).catch(e => null),
      archive.getInfo()
    ])
    indexMeta = indexMeta || {version: 0}

    // has this version of the archive been processed?
    if (indexMeta && indexMeta.version >= archiveMeta.version) {
      debug('Indexer.indexArchive no index needed for', archive.url)
      db.emit('source-indexed', archive.url, archiveMeta.version)
      return // yes, stop
    }
    debug('Indexer.indexArchive', archive.url, 'start', indexMeta.version, 'end', archiveMeta.version)

    // find and apply all changes which haven't yet been processed
    var updates = await scanArchiveHistoryForUpdates(db, archive, {
      start: indexMeta.version + 1,
      end: archiveMeta.version + 1
    })
    await applyUpdates(db, archive, updates)
    debug('Indexer.indexArchive applied', updates.length, 'updates from', archive.url)

    // emit
    db.emit('source-indexed', archive.url, archiveMeta.version)
    db.emit('indexes-updated', archive.url, archiveMeta.version)
  } finally {
    release()
  }
}
exports.indexArchive = indexArchive

// delete all records generated from the archive
async function unindexArchive (db, archive) {
  var release = await lock(`index:${archive.url}`)
  try {
    // find any relevant records and delete them from the indexes
    var recordMatches = await scanArchiveForRecords(db, archive)
    await Promise.all(recordMatches.map(match => match.table.level.del(match.recordUrl)))
    await db._indexMetaLevel.del(archive.url)
  } finally {
    release()
  }
}
exports.unindexArchive = unindexArchive

// read the file, find the matching table, validate, then store
async function readAndIndexFile (db, archive, filepath, version=false) {
  const tables = db.tables
  const fileUrl = archive.url + filepath
  try {
    // read file at given version
    const co = version ? checkoutArchive(db.DatArchive, archive, version) : archive
    var record = JSON.parse(await co.readFile(filepath))

    // index on the first matching table
    for (var i = 0; i < tables.length; i++) {
      let table = tables[i]
      if (table.isRecordFile(filepath)) {
        // validate
        let isValid = true
        if (table.schema.validate) {
          try { isValid = table.schema.validate(record) }
          catch (e) { isValid = false }
        }
        if (isValid) {
          // run preprocessor
          if (table.schema.preprocess) {
            let newRecord = table.schema.preprocess(record)
            if (newRecord) record = newRecord
          }
          // save
          let obj = {
            url: fileUrl,
            origin: archive.url,
            indexedAt: Date.now(),
            record
          }
          await table.level.put(fileUrl, obj)
          try { table.emit('put-record', obj) }
          catch (e) { console.error(e) }
        } else {
          // delete
          await table.level.del(fileUrl)
          try {
            table.emit('del-record', {
              url: fileUrl,
              origin: archive.url,
              indexedAt: Date.now()
            })
          } catch (e) { console.error(e) }
        }
      }
    }
  } catch (e) {
    console.log('Failed to index', fileUrl, e)
    throw e
  }
}
exports.readAndIndexFile = readAndIndexFile

async function unindexFile (db, archive, filepath) {
  const tables = db.tables
  const fileUrl = archive.url + filepath
  try {
    // unindex on the first matching table
    for (var i = 0; i < tables.length; i++) {
      let table = tables[i]
      if (table.isRecordFile(filepath)) {
        await table.level.del(fileUrl)
        try {
          table.emit('del-record', {
            url: fileUrl,
            origin: archive.url,
            indexedAt: Date.now()
          })
        } catch (e) { console.error(e) }
      }
    }
  } catch (e) {
    console.log('Failed to unindex', fileUrl, e)
  }
}
exports.unindexFile = unindexFile

// internal methods
// =

// helper for when the first indexArchive() fails
// emit an error, and (if it's a timeout) keep looking for the archive
async function onFailInitialIndex (e, db, archive, {watch}) {
  if (e.name === 'TimeoutError') {
    debug('Indexer.onFailInitialIndex starting retry loop', archive.url)
    db.emit('source-missing', archive.url)
    while (true) {
      veryDebug('Indexer.onFailInitialIndex attempting load', archive.url)
      // try again every 30 seconds
      await new Promise(resolve => setTimeout(resolve, 30e3))
      // still a source?
      if (!db.isOpen || !(archive.url in db._archives)) {
        return
      }
      // re-attempt the index
      try {
        await indexArchive(db, archive)
        veryDebug('Indexer.onFailInitialIndex successfully loaded', archive.url)
        break // made it!
      } catch (e) {
        // abort if we get a non-timeout error
        if (e.name !== 'TimeoutError') {
          veryDebug('Indexer.onFailInitialIndex failed attempt, aborting', archive.url, e)
          return
        }
      }
    }
    // success
    db.emit('source-found', archive.url)
    if (watch) exports.watchArchive(db, archive)
  } else {
    db.emit('source-error', archive.url, e)
  }
}

// look through the given history slice
// match against the tables' path patterns
// return back the *latest* change to each matching changed record, as an array ordered by revision
async function scanArchiveHistoryForUpdates (db, archive, {start, end}) {
  var history = await archive.history({start, end})

  // pull the latest update to each file
  var updates = {}
  history.forEach(update => {
    if (anymatch(db._tableFilePatterns, update.path)) {
      updates[update.path] = update
    }
  })

  // return an array ordered by version
  return Object.values(updates).sort((a, b) => a.version - b.version)
}

// look through the archive for any files that generate records
async function scanArchiveForRecords (db, archive) {
  var recordFiles = await Promise.all(db.tables.map(table => {
    return table.listRecordFiles(archive)
  }))
  return flatten(recordFiles)
}

// iterate the updates and apply them one by one, updating the metadata as each is applied successfully
async function applyUpdates (db, archive, updates) {
  for (let i = 0; i < updates.length; i++) {

    // process update
    var update = updates[i]
    if (update.type === 'del') {
      await unindexFile(db, archive, update.path)
    } else {
      await readAndIndexFile(db, archive, update.path, update.version)
    }

    // update meta
    await LevelUtil.update(db._indexMetaLevel, archive.url, {
      url: archive.url,
      version: update.version // record the version we've indexed
    })
  }
}
