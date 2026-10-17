const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

// Imagens de produtos e do site ficam no GridFS. As coleções "files" e "chunks"
// derivam do nome do bucket, então limpamos consultando os documentos reais em
// vez de presumir os nomes das coleções.
const BUCKET_NAME = "siteImages";
const FILES_COLLECTION = `${BUCKET_NAME}.files`;
const ANON_ORDER_RETENTION_DAYS = 30;
const ABANDONED_ORDER_RETENTION_DAYS = 180;
const ORPHAN_IMAGE_GRACE_MINUTES = 60;

// Contas que podem aparecer em um banco restaurado de backup antigo (antes de
// o login passar a usar nome de usuário). Não são logáveis, então não servem
// para nada e continuam ocupando índice único.
const LEGACY_ADMIN_FIELDS = ["email", "password", "name"];

function cutoffDate(days, now) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Descobre qual bucket do GridFS está realmente em uso.
 * Prefere o bucket configurado; se ele não tiver arquivos, usa o que tiver
 * (isso limpa bases antigas que gravaram em outro nome de bucket).
 */
async function resolveBucketName(db) {
  const configured = db.collection(FILES_COLLECTION);
  if (await configured.estimatedDocumentCount() > 0) return BUCKET_NAME;

  const candidates = (await db.listCollections().toArray())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".files"));

  let best = BUCKET_NAME;
  let bestCount = 0;
  for (const name of candidates) {
    const count = await db.collection(name).estimatedDocumentCount();
    if (count > bestCount) {
      bestCount = count;
      best = name.replace(/\.files$/, "");
    }
  }
  return best;
}

/**
 * Lista os ids de imagem referenciados por produtos e configurações do site.
 *
 * Percorre TODAS as coleções (menos as do próprio bucket) porque os nomes das
 * coleções variam conforme a versão do Mongoose que criou o banco. Um produto
 * nunca é dono de uma imagem sem que `imageId`/`galleryIds` apareça no
 * documento, então a busca por campo é segura.
 */
async function collectReferencedImageIds(db, bucketName) {
  const referenced = new Set();
  const add = (id) => { if (id) referenced.add(String(id)); };

  for (const { name } of await db.listCollections().toArray()) {
    if (name.startsWith(`${bucketName}.`)) continue;
    const cursor = db.collection(name).find({});
    for await (const doc of cursor) {
      add(doc.imageId);
      add(doc.heroImageId);
      add(doc.aboutImageId);
      for (const id of doc.galleryIds || []) add(id);
    }
  }
  return referenced;
}

/**
 * Lê os metadados de todos os arquivos do GridFS e organiza em novos e órfãos.
 * Só os metadados (sem os bytes das imagens): o custo de memória é desprezível.
 */
async function scanImages(db, bucketName, referenced, now) {
  const filesCollection = db.collection(`${bucketName}.files`);
  const chunksCollection = db.collection(`${bucketName}.chunks`);
  const graceCutoff = cutoffDate(0, now);
  graceCutoff.setMinutes(graceCutoff.getMinutes() - ORPHAN_IMAGE_GRACE_MINUTES);

  const keep = [];
  const orphans = [];
  let totalBytes = 0;
  let orphanBytes = 0;

  const cursor = filesCollection.find({}, { projection: { _id: 1, length: 1, uploadDate: 1 } });
  for await (const file of cursor) {
    const id = String(file._id);
    const length = Number(file.length) || 0;
    totalBytes += length;
    // Arquivo recém-enviado pode ainda não estar ligado a um produto (o upload
    // acontece antes de salvar). Por isso existe uma carência antes de apagar.
    const isRecent = file.uploadDate && file.uploadDate > graceCutoff;
    if (referenced.has(id) || isRecent) {
      keep.push(file);
    } else {
      orphans.push(file);
      orphanBytes += length;
    }
  }

  // Chunks que não pertencem a nenhum arquivo (upload interrompido).
  const validIds = [...keep, ...orphans].map((file) => file._id);
  const chunkFilter = validIds.length ? { files_id: { $nin: validIds } } : {};
  // Não conta chunks de arquivos que acabaram de ser enviados.
  const recentFilter = { uploadDate: { $gt: graceCutoff } };
  const recentIds = (await filesCollection.find(recentFilter, { projection: { _id: 1 } }).toArray()).map((f) => f._id);
  const safeChunkFilter = recentIds.length ? { ...chunkFilter, files_id: { $nin: [...validIds, ...recentIds] } } : chunkFilter;
  const strayChunks = await chunksCollection.countDocuments(safeChunkFilter);

  // Documentos "files" sem nenhum chunk: arquivo corrompido, não abre.
  const chunkOwners = await chunksCollection.distinct("files_id");
  const ownerSet = new Set(chunkOwners.map(String));
  const emptyFiles = [...keep, ...orphans].filter((file) => !ownerSet.has(String(file._id)));

  return { keep, orphans, orphanBytes, totalBytes, strayChunks, strayChunkFilter: safeChunkFilter, emptyFiles };
}

/**
 * Remove documentos de sessão já expirados.
 * O connect-mongo limpa sozinho, mas isso garante a limpeza mesmo com o
 * servidor parado por muito tempo.
 */
async function pruneSessions(db, now, report) {
  const sessions = db.collection("sessions");
  if (!await sessions.findOne({}, { projection: { _id: 1 } })) return;

  const expires = await sessions.find({}, { projection: { expires: 1 } }).toArray();
  const expiredIds = expires.filter((doc) => doc.expires && new Date(doc.expires) < now).map((doc) => doc._id);
  if (!expiredIds.length) return;

  if (report.dryRun) {
    report.removed.sessionsExpired = expiredIds.length;
    return;
  }
  const deleted = await sessions.deleteMany({ _id: { $in: expiredIds } });
  report.removed.sessionsExpired = deleted.deletedCount;
}

/**
 * Remove pedidos que não têm valor nenhum para a loja:
 *  - abandonados: seguem "pending" depois de muito tempo (desistiram);
 *  - anônimos: sem nome do cliente, antigos, já finalizados.
 * Pedidos com nome e recentes são sempre preservados como histórico.
 */
async function pruneOrders(db, now, report) {
  const orders = db.collection("orders");
  if (!await orders.findOne({}, { projection: { _id: 1 } })) return;

  const abandonedBefore = cutoffDate(ABANDONED_ORDER_RETENTION_DAYS, now);
  const anonymousBefore = cutoffDate(ANON_ORDER_RETENTION_DAYS, now);

  // Abandonado = segue pendente depois de muito tempo. Só removemos os SEM
  // nome: um pedido nomeado antigo pode ser histórico ou um combinado em
  // aberto com o cliente, e não vale o risco de apagar.
  const abandoned = await orders.find(
    { status: "pending", customerName: "", createdAt: { $lt: abandonedBefore } },
    { projection: { _id: 1 } },
  ).toArray();
  const anonymous = await orders.find(
    { status: { $ne: "pending" }, customerName: "", createdAt: { $lt: anonymousBefore } },
    { projection: { _id: 1 } },
  ).toArray();

  const ids = [...new Set([...abandoned, ...anonymous].map((doc) => doc._id))];
  if (!ids.length) return;

  if (report.dryRun) {
    report.removed.ordersAbandoned = abandoned.length;
    report.removed.ordersAnonymous = anonymous.length;
    return;
  }
  const deleted = await orders.deleteMany({ _id: { $in: ids } });
  report.removed.ordersAbandoned = abandoned.length;
  report.removed.ordersAnonymous = anonymous.length;
  report.removed.ordersTotal = deleted.deletedCount;
}

/** Remove contas administrativas do formato antigo, que não conseguem logar. */
async function pruneLegacyAdmins(db, report) {
  const admins = db.collection("admins");
  const filter = {
    $or: [
      { username: { $exists: false } },
      { username: null },
      ...LEGACY_ADMIN_FIELDS.map((field) => ({ [field]: { $exists: true } })),
    ],
  };
  const found = await admins.countDocuments(filter);
  if (!found) return;

  if (report.dryRun) {
    report.removed.legacyAdmins = found;
    return;
  }
  const deleted = await admins.deleteMany(filter);
  report.removed.legacyAdmins = deleted.deletedCount;
}

/**
 * Compacta o banco: remove índices duplicados/obsoletos e devolve ao sistema
 * o espaço que o MongoDB reservou mas não usa mais.
 */
async function compact(db, report) {
  const { collections } = report;
  for (const name of collections) {
    const collection = db.collection(name);
    const indexes = await collection.indexes().catch(() => []);

    // Índices que são prefixo exato de outro são redundantes.
    const redundant = indexes.filter((index) => {
      if (index.name === "_id_") return false;
      const keys = Object.keys(index.key);
      return indexes.some((other) => {
        if (other.name === index.name) return false;
        const otherKeys = Object.keys(other.key);
        if (otherKeys.length <= keys.length) return false;
        return keys.every((key, position) => otherKeys[position] === key && other.key[key] === index.key[key]);
      });
    });

    for (const index of redundant) {
      report.compaction.redundantIndexes.push(`${name}.${index.name}`);
      if (!report.dryRun) await collection.dropIndex(index.name).catch(() => {});
    }

    // compact só reduz o espaço reservado no disco/disco remoto.
    if (!report.dryRun) {
      await db.command({ compact: name }).catch(() => { /* recurso opcional */ });
    }
  }
}

/**
 * Executa a manutenção completa.
 * @param {object} options
 * @param {boolean} [options.dryRun] apenas relata, sem apagar nada.
 * @param {boolean} [options.compact] roda a compactação de espaço.
 * @returns {Promise<object>} relatório do que foi encontrado/removido.
 */
async function runMaintenance({ dryRun = false, compact: shouldCompact = false, now = new Date() } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Banco de dados não conectado.");

  const report = {
    startedAt: now.toISOString(),
    dryRun,
    bucket: BUCKET_NAME,
    removed: {
      images: 0,
      imageBytes: 0,
      chunks: 0,
      emptyImageFiles: 0,
      sessionsExpired: 0,
      ordersAbandoned: 0,
      ordersAnonymous: 0,
      ordersTotal: 0,
      legacyAdmins: 0,
    },
    freedBytes: 0,
    imagesKept: 0,
    imageBytesTotal: 0,
    collections: [],
    compaction: { redundantIndexes: [], compacted: [] },
    warnings: [],
  };

  const bucketName = await resolveBucketName(db);
  report.bucket = bucketName;

  const referenced = await collectReferencedImageIds(db, bucketName);
  report.referencedImages = referenced.size;

  const scan = await scanImages(db, bucketName, referenced, now);
  report.imagesKept = scan.keep.length;
  report.imageBytesTotal = scan.totalBytes;

  // Arquivos sem chunk nenhum não podem ser lidos: remove sem carência.
  if (!dryRun && scan.emptyFiles.length) {
    const result = await db.collection(`${bucketName}.files`).deleteMany({ _id: { $in: scan.emptyFiles.map((f) => f._id) } });
    report.removed.emptyImageFiles = result.deletedCount;
  } else if (dryRun) {
    report.removed.emptyImageFiles = scan.emptyFiles.length;
  }

  if (scan.orphans.length) {
    report.removed.images = scan.orphans.length;
    report.removed.imageBytes = scan.orphanBytes;
    report.freedBytes += scan.orphanBytes;
    if (!dryRun) {
      const bucket = new GridFSBucket(db, { bucketName });
      for (const file of scan.orphans) {
        // delete também remove os chunks correspondentes.
        await bucket.delete(file._id).catch(() => { /* já removido */ });
      }
    }
  }

  // Chunks sem arquivo (upload interrompido no meio). O filtro é sempre
  // recalculado aqui, depois de remover as imagens órfãs, para não sobrar
  // nenhum chunk apontando para um arquivo que não existe mais.
  const strayFilter = await buildStrayChunkFilter(db, bucketName, now);
  const strayChunkCount = await db.collection(`${bucketName}.chunks`).countDocuments(strayFilter);
  if (strayChunkCount > 0) {
    report.removed.chunks = strayChunkCount;
    if (!dryRun) {
      const deleted = await db.collection(`${bucketName}.chunks`).deleteMany(strayFilter);
      report.removed.chunks = deleted.deletedCount;
    }
  }

  await pruneSessions(db, now, report);
  await pruneOrders(db, now, report);
  await pruneLegacyAdmins(db, report);

  report.collections = (await db.listCollections().toArray())
    .map((entry) => entry.name)
    .filter((name) => name !== `${bucketName}.chunks`);

  if (shouldCompact) await compact(db, report);

  report.finishedAt = new Date().toISOString();
  return report;
}

/** Monta o filtro de chunks órfãos no momento da remoção. */
async function buildStrayChunkFilter(db, bucketName, now) {
  const files = await db.collection(`${bucketName}.files`).find({}, { projection: { _id: 1, uploadDate: 1 } }).toArray();
  const recentCutoff = new Date(now.getTime() - ORPHAN_IMAGE_GRACE_MINUTES * 60 * 1000);
  const recentIds = files.filter((f) => f.uploadDate && f.uploadDate > recentCutoff).map((f) => f._id);
  const knownIds = files.map((f) => f._id);
  return { files_id: { $nin: [...knownIds, ...recentIds] } };
}

module.exports = {
  runMaintenance,
  BUCKET_NAME,
  resolveBucketName,
  collectReferencedImageIds,
  ORPHAN_IMAGE_GRACE_MINUTES,
  ANON_ORDER_RETENTION_DAYS,
  ABANDONED_ORDER_RETENTION_DAYS,
};
