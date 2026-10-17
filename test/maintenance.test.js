const test = require("node:test");
const assert = require("node:assert/strict");

// Testes da manutenção do banco. Usam um "banco" falso em memória para
// verificar a lógica de decisão (o que é órfão, o que é preservado) sem
// depender de MongoDB real. As funções recebem `db` por parâmetro justamente
// para permitir isso.
const mongoose = require("mongoose");

function makeCollection(docs) {
  const rows = docs.map((doc) => ({ ...doc }));
  const matches = (doc, query) => Object.entries(query || {}).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$nin" in value) return !value.$nin.map(String).includes(String(doc[key]));
      if ("$exists" in value) return value.$exists ? doc[key] !== undefined : doc[key] === undefined;
      if ("$ne" in value) return String(doc[key]) !== String(value.$ne);
      if ("$lt" in value) return doc[key] !== undefined && new Date(doc[key]) < new Date(value.$lt);
      if ("$gt" in value) return doc[key] !== undefined && new Date(doc[key]) > new Date(value.$gt);
      if ("$in" in value) return value.$in.map(String).includes(String(doc[key]));
    }
    if ("$or" in (query || {})) return true;
    return String(doc[key]) === String(value);
  });

  return {
    rows,
    async estimatedDocumentCount() { return rows.length; },
    async countDocuments(query) { return rows.filter((doc) => matches(doc, query)).length; },
    async findOne(query) { return rows.find((doc) => matches(doc, query)) || null; },
    find(query = {}) {
      const selected = rows.filter((doc) => matches(doc, query));
      return {
        async toArray() { return selected; },
        async *[Symbol.asyncIterator]() { for (const doc of selected) yield doc; },
      };
    },
    async distinct(key) { return [...new Set(rows.map((doc) => doc[key]).filter(Boolean))]; },
    async deleteMany(query) {
      const removed = rows.filter((doc) => matches(doc, query));
      for (const doc of removed) rows.splice(rows.indexOf(doc), 1);
      return { deletedCount: removed.length };
    },
    async indexes() { return []; },
    async dropIndex() {},
  };
}

function makeFakeDb(collections) {
  const store = new Map(Object.entries(collections).map(([name, docs]) => [name, makeCollection(docs)]));
  return {
    store,
    collection(name) {
      if (!store.has(name)) store.set(name, makeCollection([]));
      return store.get(name);
    },
    listCollections() {
      const names = [...store.keys()];
      return { async toArray() { return names.map((name) => ({ name })); } };
    },
    async command() { return {}; },
  };
}

const now = new Date("2026-06-01T12:00:00Z");
const minutesAgo = (m) => new Date(now.getTime() - m * 60 * 1000);
const daysAgo = (d) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

async function loadMaintenanceWithDb(db) {
  // A função usa `mongoose.connection.db`, então injetamos o banco falso.
  mongoose.connection.db = db;
  delete require.cache[require.resolve("../lib/maintenance")];
  return require("../lib/maintenance");
}

test("manutenção remove imagens órfãs e preserva as referenciadas", async () => {
  const keptId = new mongoose.Types.ObjectId();
  const orphanId = new mongoose.Types.ObjectId();
  const db = makeFakeDb({
    "siteImages.files": [
      { _id: keptId, length: 1000, uploadDate: daysAgo(5) },
      { _id: orphanId, length: 4096, uploadDate: daysAgo(3) },
    ],
    "siteImages.chunks": [
      { files_id: keptId, n: 0, data: Buffer.alloc(1000) },
      { files_id: orphanId, n: 0, data: Buffer.alloc(4096) },
    ],
    products: [{ _id: new mongoose.Types.ObjectId(), imageId: keptId, galleryIds: [] }],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.images, 1, "deve remover exatamente a imagem órfã");
  assert.equal(report.removed.imageBytes, 4096);
  assert.equal(report.imagesKept, 1, "deve manter a imagem referenciada");
  assert.equal(db.store.get("siteImages.files").rows.length, 1);
  assert.equal(String(db.store.get("siteImages.files").rows[0]._id), String(keptId));
  assert.equal(db.store.get("siteImages.chunks").rows.length, 1, "chunks da órfã também saem");
});

test("manutenção preserva upload recém-feito (carência evita apagar em uso)", async () => {
  const freshId = new mongoose.Types.ObjectId();
  const db = makeFakeDb({
    "siteImages.files": [{ _id: freshId, length: 2048, uploadDate: minutesAgo(5) }],
    "siteImages.chunks": [{ files_id: freshId, n: 0, data: Buffer.alloc(2048) }],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.images, 0, "não pode apagar imagem recém-enviada");
  assert.equal(report.imagesKept, 1);
  assert.equal(db.store.get("siteImages.files").rows.length, 1);
});

test("dry-run relata sem apagar nada", async () => {
  const orphanId = new mongoose.Types.ObjectId();
  const db = makeFakeDb({
    "siteImages.files": [{ _id: orphanId, length: 512, uploadDate: daysAgo(10) }],
    "siteImages.chunks": [{ files_id: orphanId, n: 0, data: Buffer.alloc(512) }],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: true, now });

  assert.equal(report.removed.images, 1, "deve relatar a órfã");
  assert.equal(db.store.get("siteImages.files").rows.length, 1, "mas não pode apagar em dry-run");
  assert.equal(db.store.get("siteImages.chunks").rows.length, 1);
});

test("manutenção remove pedidos abandonados e anônimos antigos, preservando os úteis", async () => {
  const db = makeFakeDb({
    orders: [
      { _id: new mongoose.Types.ObjectId(), status: "pending", customerName: "", createdAt: daysAgo(400) },
      { _id: new mongoose.Types.ObjectId(), status: "delivered", customerName: "", createdAt: daysAgo(400) },
      { _id: new mongoose.Types.ObjectId(), status: "delivered", customerName: "", createdAt: daysAgo(2) },
      { _id: new mongoose.Types.ObjectId(), status: "pending", customerName: "", createdAt: daysAgo(2) },
      { _id: new mongoose.Types.ObjectId(), status: "delivered", customerName: "Maria", createdAt: daysAgo(400) },
      { _id: new mongoose.Types.ObjectId(), status: "pending", customerName: "João", createdAt: daysAgo(400) },
    ],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.ordersAbandoned, 1, "só o pending antigo (sem nome) é abandonado");
  assert.equal(report.removed.ordersAnonymous, 1, "só o finalizado antigo sem nome é anônimo");
  const remaining = db.store.get("orders").rows;
  assert.equal(remaining.length, 4);
  assert.ok(remaining.some((order) => order.customerName === "Maria"), "pedido com nome é histórico");
  assert.ok(remaining.some((order) => order.customerName === "João"), "pedido com nome é histórico");
});

test("manutenção remove contas antigas sem login e mantém as válidas", async () => {
  const db = makeFakeDb({
    admins: [
      { _id: new mongoose.Types.ObjectId(), username: "ADM", passwordHash: "x" },
      { _id: new mongoose.Types.ObjectId(), email: "velho@exemplo.com", password: "legado" },
    ],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.legacyAdmins, 1);
  assert.equal(db.store.get("admins").rows.length, 1);
  assert.equal(db.store.get("admins").rows[0].username, "ADM");
});

test("manutenção remove sessões expiradas e mantém as ativas", async () => {
  const db = makeFakeDb({
    sessions: [
      { _id: "expirada", expires: daysAgo(1) },
      { _id: "ativa", expires: new Date(now.getTime() + 3600_000) },
    ],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.sessionsExpired, 1);
  assert.equal(db.store.get("sessions").rows.length, 1);
  assert.equal(db.store.get("sessions").rows[0]._id, "ativa");
});

test("manutenção remove chunks soltos sem arquivo correspondente", async () => {
  const orphanChunkFileId = new mongoose.Types.ObjectId();
  const db = makeFakeDb({
    "siteImages.files": [],
    "siteImages.chunks": [{ files_id: orphanChunkFileId, n: 0, data: Buffer.alloc(64) }],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.chunks, 1);
  assert.equal(db.store.get("siteImages.chunks").rows.length, 0);
});

test("manutenção detecta imagens corrompidas (documento sem chunks)", async () => {
  const brokenId = new mongoose.Types.ObjectId();
  const db = makeFakeDb({
    "siteImages.files": [{ _id: brokenId, length: 999, uploadDate: daysAgo(10) }],
    "siteImages.chunks": [],
    products: [],
  });
  const { runMaintenance } = await loadMaintenanceWithDb(db);
  const report = await runMaintenance({ dryRun: false, now });

  assert.equal(report.removed.emptyImageFiles, 1);
  assert.equal(db.store.get("siteImages.files").rows.length, 0);
});
