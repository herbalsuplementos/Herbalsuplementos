require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const mongoose = require("mongoose");
const { GridFSBucket, ObjectId } = require("mongodb");
const helmet = require("helmet");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const { runMaintenance } = require("./lib/maintenance");
const { optimizeImage } = require("./lib/images");

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SITE_ORIGIN = process.env.SITE_ORIGIN || `http://localhost:${PORT}`;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_GALLERY = 5;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_ENABLED = process.env.CLEANUP_ENABLED !== "false";
const imageOptimizationEnabled = process.env.IMAGE_OPTIMIZATION !== "false";
const app = express();
let imageBucket;
// Servidor tradicional: roda na raiz do projeto. Vercel: a função é executada a
// partir de outro diretório, então procuramos a pasta pública nos dois lugares.
const PUBLIC_DIR = [
  path.join(__dirname, "public"),
  path.join(process.cwd(), "public"),
].find((dir) => fs.existsSync(path.join(dir, "index.html"))) || path.join(__dirname, "public");
// O runner de testes do Node define esta variável; nesse contexto não abrimos
// conexão com o banco nem usamos o store de sessão no MongoDB.
const inTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
// No Vercel a aplicação fica atrás de um proxy: sem isso o protocolo/IP vistos
// pela aplicação ficam errados (cookies seguros e limitador de tentativas).
const trustProxy = process.env.TRUST_PROXY === "1" || Boolean(process.env.VERCEL);
app.set("trust proxy", trustProxy ? 1 : false);

const adminUsernameInput = z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/);
const optionalText = (max) => z.string().trim().max(max).optional().default("");
const productInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: optionalText(1200),
  categoryId: z.string().regex(/^[a-f\d]{24}$/i),
  price: z.union([z.literal(""), z.string().max(15).regex(/^\d+([.,]\d{1,2})?$/)]).optional().default(""),
  active: z.enum(["true", "false"]).optional().default("true"),
  featured: z.enum(["true", "false"]).optional().default("false"),
  promotion: z.enum(["true", "false"]).optional().default("false"),
  new: z.enum(["true", "false"]).optional().default("false"),
  removeImage: z.enum(["true", "false"]).optional().default("false"),
  removeGallery: z.string().max(400).optional().default(""),
});
const categoryInput = z.object({
  name: z.string().trim().min(1).max(80),
  order: z.coerce.number().int().min(0).max(10000).default(0),
});
const settingsInput = z.object({
  topbar: optionalText(180),
  heroTitle: z.string().trim().min(1).max(160),
  heroText: optionalText(1000),
  aboutTitle: optionalText(120),
  aboutText: optionalText(2000),
  whatsapp: z.string().regex(/^\d{10,15}$/),
  phone: optionalText(40),
  address: optionalText(240),
  hours: optionalText(500),
  mapUrl: z.union([z.literal(""), z.string().max(500).url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol))]).optional().default(""),
  instagram: z.union([z.literal(""), z.string().max(500).url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol))]).optional().default(""),
  facebook: z.union([z.literal(""), z.string().max(500).url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol))]).optional().default(""),
  removeHeroImage: z.enum(["true", "false"]).optional().default("false"),
  removeAboutImage: z.enum(["true", "false"]).optional().default("false"),
});

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  order: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
categorySchema.index({ order: 1, name: 1 });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: "", maxlength: 1200 },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
  categoryName: { type: String, required: true, maxlength: 80 },
  price: { type: Number, min: 0, default: null },
  imageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  galleryIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  active: { type: Boolean, default: true },
  featured: { type: Boolean, default: false },
  promotion: { type: Boolean, default: false },
  new: { type: Boolean, default: false },
}, { timestamps: true });
productSchema.index({ active: 1, featured: -1, name: 1 });
productSchema.index({ categoryId: 1, active: 1 });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "site" },
  topbar: { type: String, default: "Bem-vindo Ã  Herbal Suplementos", maxlength: 180 },
  heroTitle: { type: String, default: "Mais natureza no seu dia a dia", maxlength: 160 },
  heroText: { type: String, default: "Encontre produtos naturais para a sua rotina. Fale com a nossa equipe e conheÃ§a o catÃ¡logo.", maxlength: 1000 },
  heroImageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  aboutTitle: { type: String, default: "Cuidado natural, atendimento prÃ³ximo", maxlength: 120 },
  aboutText: { type: String, default: "ConheÃ§a a Herbal Suplementos e converse com a nossa equipe para encontrar os produtos que procura.", maxlength: 2000 },
  aboutImageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  whatsapp: { type: String, default: "553899662812", match: /^\d{10,15}$/ },
  phone: { type: String, default: "", maxlength: 40 },
  address: { type: String, default: "", maxlength: 240 },
  hours: { type: String, default: "", maxlength: 500 },
  mapUrl: { type: String, default: "", maxlength: 500 },
  instagram: { type: String, default: "https://www.instagram.com/herbalsuplementos.terapiaervas/", maxlength: 500 },
  facebook: { type: String, default: "", maxlength: 500 },
}, { timestamps: true });

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, uppercase: true, trim: true, minlength: 1, maxlength: 32, match: /^[A-Z0-9_-]+$/ },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin"], default: "admin" },
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  items: [{
    _id: false,
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    categoryName: { type: String, default: "" },
    unitPrice: { type: Number, min: 0, required: true },
    quantity: { type: Number, min: 1, max: 99, required: true },
    subtotal: { type: Number, min: 0, required: true },
  }],
  total: { type: Number, min: 0, required: true },
  customerName: { type: String, default: "", maxlength: 80 },
  status: { type: String, enum: ["pending", "delivered", "cancelled"], default: "pending" },
  deliveredAt: { type: Date, default: null },
  handledBy: { type: String, default: "" },
}, { timestamps: true });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

const Category = mongoose.model("Category", categorySchema);
const Order = mongoose.model("Order", orderSchema);
const Product = mongoose.model("Product", productSchema);
const SiteSettings = mongoose.model("SiteSettings", settingsSchema);
const Admin = mongoose.model("Admin", adminSchema);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(session({
  name: "herbal.sid",
  secret: SESSION_SECRET || "configuration-required-session-secret",
  resave: false,
  saveUninitialized: false,
  // Em produção (inclusive no Vercel, onde cada invocação pode cair em outra
  // instância) as sessões precisam ficar no MongoDB para o login do painel
  // sobreviver entre requisições. Nos testes usamos o store em memória.
  store: MONGODB_URI && !inTestRunner
    ? MongoStore.create({ mongoUrl: MONGODB_URI, collectionName: "sessions" })
    : undefined,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.get("/", (request, response) => response.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get(["/admin", "/admin/"], (request, response) => response.sendFile(path.join(PUBLIC_DIR, "admin", "index.html")));
app.use("/css", express.static(path.join(PUBLIC_DIR, "css"), { dotfiles: "deny" }));
app.use("/Js", express.static(path.join(PUBLIC_DIR, "Js"), { dotfiles: "deny" }));
for (const page of ["termos", "privacidade", "cookies"]) {
  app.get(`/${page}`, (request, response) => response.sendFile(path.join(PUBLIC_DIR, "legal", `${page}.html`)));
}
app.use("/admin", express.static(path.join(PUBLIC_DIR, "admin"), { dotfiles: "deny", index: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE, files: 6, fields: 20, fieldSize: 4096, parts: 28 },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
});

function requireAdmin(request, response, next) {
  if (!request.session.adminId) {
    return response.status(401).json({ error: "Entre no painel para continuar." });
  }
  return next();
}

function requireSameOrigin(request, response, next) {
  // Aceita a origem configurada e tambÃ©m a origem real da requisiÃ§Ã£o, para o painel
  // continuar funcionando quando o site Ã© acessado por outro host/porta (ex.: rede local).
  // Isso nÃ£o enfraquece a proteÃ§Ã£o: o token CSRF abaixo Ã© o que barra ataques.
  const allowed = new Set([SITE_ORIGIN]);
  try {
    allowed.add(new URL(`${request.protocol}://${request.get("host")}`).origin);
  } catch { /* host invÃ¡lido: mantÃ©m apenas SITE_ORIGIN */ }
  const origin = request.get("origin");
  if (origin && !allowed.has(origin)) {
    return response.status(403).json({ error: "Origem da solicitaÃ§Ã£o nÃ£o permitida." });
  }
  const token = request.get("x-csrf-token");
  const expected = request.session.csrfToken;
  if (!token || !expected) {
    return response.status(403).json({ error: "SessÃ£o expirada. Atualize a pÃ¡gina e tente novamente." });
  }
  const suppliedToken = Buffer.from(token);
  const expectedToken = Buffer.from(expected);
  if (suppliedToken.length !== expectedToken.length || !crypto.timingSafeEqual(suppliedToken, expectedToken)) {
    return response.status(403).json({ error: "SessÃ£o expirada. Atualize a pÃ¡gina e tente novamente." });
  }
  return next();
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function publicProduct(product) {
  return {
    id: product._id,
    name: product.name,
    description: product.description,
    categoryId: product.categoryId,
    category: product.categoryName,
    price: product.price,
    imageUrl: product.imageId ? `/api/images/${product.imageId}` : "",
    gallery: (product.galleryIds || []).map((id) => ({ id, url: `/api/images/${id}` })),
    featured: product.featured,
    promotion: product.promotion,
    new: product.new,
  };
}

function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", contentType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

async function storeImage(file) {
  if (!file) return null;
  const type = imageType(file.buffer);
  if (!type) {
    const error = new Error("Use uma imagem PNG, JPG ou WebP vÃ¡lida.");
    error.status = 400;
    throw error;
  }
  // Reduz a imagem antes de gravar: o banco guarda os bytes, entÃ£o otimizar
  // aqui Ã© o que realmente economiza espaÃ§o (ver lib/images.js).
  const optimized = imageOptimizationEnabled
    ? await optimizeImage(file.buffer)
    : { buffer: file.buffer, contentType: type.contentType, extension: type.extension, originalBytes: file.buffer.length, optimizedBytes: file.buffer.length, changed: false };
  if (optimized.warning) console.warn("[imagens]", optimized.warning);
  const id = new ObjectId();
  await new Promise((resolve, reject) => {
    const stream = imageBucket.openUploadStreamWithId(id, `${id}.${optimized.extension}`, {
      contentType: optimized.contentType,
      metadata: {
        uploadedAt: new Date(),
        optimized: optimized.changed,
        originalBytes: optimized.originalBytes,
        bytes: optimized.buffer.length,
      },
    });
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(optimized.buffer);
  });
  return id;
}

async function removeImage(id) {
  if (!id) return;
  try {
    await imageBucket.delete(new ObjectId(id));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Lista explÃ­cita de campos: nada que venha do corpo (ex.: galleryIds, imageId)
// pode entrar no produto por engano. Sem espalhar `...parsed`.
const PRODUCT_FIELDS = ["name", "description", "categoryId", "price", "active", "featured", "promotion", "new"];

function parseProductInput(body) {
  const parsed = productInput.parse(body);
  const removeGalleryIds = new Set(parsed.removeGallery.split(",").map((id) => id.trim()).filter((id) => /^[a-f\d]{24}$/i.test(id)));
  const fields = {};
  for (const field of PRODUCT_FIELDS) fields[field] = parsed[field];
  fields.price = parsed.price ? Number(parsed.price.replace(",", ".")) : null;
  return {
    fields,
    removeImage: parsed.removeImage === "true",
    // Set: evita comparaÃ§Ã£o O(n*m) com listas grandes e remove duplicatas.
    removeGalleryIds,
  };
}

app.get("/api/health", asyncRoute(async (request, response) => {
  if (inTestRunner) return response.json({ status: "ok", db: "test" });
  if (!MONGODB_URI) {
    return response.status(500).json({ status: "unavailable", db: "missing_config" });
  }
  try {
    await ensureReady();
    return response.json({ status: "ok", db: "connected" });
  } catch {
    return response.status(503).json({ status: "unavailable", db: "disconnected" });
  }
}));

// Em serverless cada invocação reusa (ou não) o processo: guardamos a promessa
// de conexão para não reconectar a cada requisição e criamos o bucket do GridFS
// na primeira vez que o banco responde.
let readyPromise = null;
async function ensureReady() {
  if (mongoose.connection.readyState !== 1) {
    if (!readyPromise) {
      readyPromise = mongoose.connect(MONGODB_URI).catch((error) => {
        readyPromise = null; // permite tentar de novo na próxima requisição
        throw error;
      });
    }
    await readyPromise;
  }
  if (!imageBucket) imageBucket = new GridFSBucket(mongoose.connection.db, { bucketName: "siteImages" });
}

// Garante banco conectado antes das rotas que leem/escrevem. Fica fora do
// /api/health para o diagnóstico de saúde continuar respondendo sem banco.
function dbReady(request, response, next) {
  if (inTestRunner) return next();
  if (!MONGODB_URI) {
    return next(Object.assign(new Error("Defina MONGODB_URI nas variáveis de ambiente."), { status: 500 }));
  }
  return ensureReady().then(() => next()).catch(next);
}

app.use("/api", dbReady);

app.get("/api/csrf", (request, response) => {
  if (!request.session.csrfToken) request.session.csrfToken = crypto.randomBytes(32).toString("hex");
  response.json({ token: request.session.csrfToken });
});

app.post("/api/admin/login", loginLimiter, requireSameOrigin, asyncRoute(async (request, response) => {
  const username = adminUsernameInput.safeParse(request.body.username);
  const password = z.string().min(1).max(200).safeParse(request.body.password);
  if (!username.success || !password.success) {
    return response.status(401).json({ error: "UsuÃ¡rio ou senha incorretos." });
  }
  const admin = await Admin.findOne({ username: username.data.toUpperCase() }).select("+passwordHash");
  if (!admin || !(await bcrypt.compare(password.data, admin.passwordHash))) {
    return response.status(401).json({ error: "UsuÃ¡rio ou senha incorretos." });
  }
  await new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
  request.session.adminId = admin.id;
  request.session.adminName = admin.username;
  request.session.csrfToken = crypto.randomBytes(32).toString("hex");
  return response.json({ ok: true, csrfToken: request.session.csrfToken });
}));

app.get("/api/admin/session", (request, response) => {
  response.json({ authenticated: Boolean(request.session.adminId) });
});

app.post("/api/admin/logout", requireAdmin, requireSameOrigin, (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie("herbal.sid", { httpOnly: true, sameSite: "strict" });
    return response.json({ ok: true });
  });
});

app.get("/api/site", asyncRoute(async (request, response) => {
  const settings = (await SiteSettings.findOne({ key: "site" }).lean()) || new SiteSettings().toObject();
  const categories = await Category.find().sort({ order: 1, name: 1 }).lean();
  const products = await Product.find({ active: true }).sort({ featured: -1, name: 1 }).lean();
  response.json({
    settings: settings ? {
      topbar: settings.topbar,
      heroTitle: settings.heroTitle,
      heroText: settings.heroText,
      heroImageUrl: settings.heroImageId ? `/api/images/${settings.heroImageId}` : "",
      aboutTitle: settings.aboutTitle,
      aboutText: settings.aboutText,
      aboutImageUrl: settings.aboutImageId ? `/api/images/${settings.aboutImageId}` : "",
      whatsapp: settings.whatsapp,
      phone: settings.phone,
      address: settings.address,
      hours: settings.hours,
      mapUrl: settings.mapUrl,
      instagram: settings.instagram,
      facebook: settings.facebook,
    } : {},
    categories: categories.map(({ _id, name, order }) => ({ id: _id, name, order })),
    products: products.map(publicProduct),
  });
}));

app.get("/api/images/:id", asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.sendStatus(404);
  const files = await imageBucket.find({ _id: new ObjectId(request.params.id) }).toArray();
  if (!files.length) return response.sendStatus(404);
  response.set({
    "Content-Type": files[0].contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  const stream = imageBucket.openDownloadStream(new ObjectId(request.params.id));
  stream.on("error", (error) => {
    if (!response.headersSent) response.sendStatus(404);
    else response.destroy(error);
  });
  stream.pipe(response);
}));

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeInput = z.string().trim().toUpperCase().regex(/^HB-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
const orderInput = z.object({
  customerName: z.string().trim().max(80).optional().default(""),
  items: z.array(z.object({
    productId: z.string().regex(/^[a-f\d]{24}$/i),
    quantity: z.coerce.number().int().min(1).max(99),
  })).min(1).max(30),
});
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitos pedidos em pouco tempo. Tente novamente mais tarde." },
});

function generateOrderCode() {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  return `HB-${pick()}-${pick()}`;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function publicOrder(order) {
  return {
    id: order._id,
    code: order.code,
    items: order.items,
    total: order.total,
    customerName: order.customerName,
    status: order.status,
    createdAt: order.createdAt,
    deliveredAt: order.deliveredAt,
    handledBy: order.handledBy,
  };
}

app.post("/api/orders", orderLimiter, asyncRoute(async (request, response) => {
  const parsed = orderInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Carrinho invÃ¡lido." });
  const quantities = new Map();
  for (const item of parsed.data.items) {
    quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  }
  const products = await Product.find({ _id: { $in: [...quantities.keys()] }, active: true }).lean();
  if (products.length !== quantities.size) {
    return response.status(400).json({ error: "Algum produto nÃ£o estÃ¡ mais disponÃ­vel. Atualize a pÃ¡gina." });
  }
  const items = [];
  for (const product of products) {
    const quantity = quantities.get(String(product._id));
    if (product.price === null || product.price === undefined) {
      return response.status(400).json({ error: `"${product.name}" estÃ¡ sem preÃ§o definido. Consulte a equipe.` });
    }
    if (quantity > 99) return response.status(400).json({ error: "Quantidade mÃ¡xima por produto: 99." });
    items.push({
      productId: product._id,
      name: product.name,
      categoryName: product.categoryName,
      unitPrice: product.price,
      quantity,
      subtotal: roundMoney(product.price * quantity),
    });
  }
  const total = roundMoney(items.reduce((sum, item) => sum + item.subtotal, 0));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const order = await Order.create({ code: generateOrderCode(), items, total, customerName: parsed.data.customerName });
      return response.status(201).json({ code: order.code, total: order.total, items: order.items, customerName: order.customerName });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  throw new Error("NÃ£o foi possÃ­vel gerar um cÃ³digo de pedido.");
}));

app.use("/api/admin", requireAdmin, requireSameOrigin);

app.get("/api/admin/orders", asyncRoute(async (request, response) => {
  const status = ["pending", "delivered", "cancelled"].includes(request.query.status) ? { status: request.query.status } : {};
  const orders = await Order.find(status).sort({ createdAt: -1 }).limit(100).lean();
  response.json(orders.map(publicOrder));
}));

app.get("/api/admin/orders/code/:code", asyncRoute(async (request, response) => {
  const code = codeInput.safeParse(request.params.code);
  if (!code.success) return response.status(400).json({ error: "CÃ³digo invÃ¡lido. Formato: HB-XXXX-XXXX." });
  const order = await Order.findOne({ code: code.data }).lean();
  if (!order) return response.status(404).json({ error: "Pedido nÃ£o encontrado." });
  return response.json(publicOrder(order));
}));

for (const [action, status] of [["deliver", "delivered"], ["cancel", "cancelled"]]) {
  app.post(`/api/admin/orders/:id/${action}`, asyncRoute(async (request, response) => {
    if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Pedido invÃ¡lido." });
    const order = await Order.findOneAndUpdate(
      { _id: request.params.id, status: "pending" },
      { status, deliveredAt: status === "delivered" ? new Date() : null, handledBy: request.session.adminName || "" },
      { new: true },
    ).lean();
    if (!order) return response.status(409).json({ error: "Pedido nÃ£o encontrado ou jÃ¡ finalizado." });
    return response.json(publicOrder(order));
  }));
}

app.patch("/api/admin/products/:id/price", asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Produto invÃ¡lido." });
  const price = z.object({
    price: z.union([z.null(), z.literal(""), z.string().max(15).regex(/^\d+([.,]\d{1,2})?$/), z.number().min(0).max(1000000)]),
  }).safeParse(request.body);
  if (!price.success) return response.status(400).json({ error: "PreÃ§o invÃ¡lido." });
  const raw = price.data.price;
  const value = raw === null || raw === "" ? null : Number(String(raw).replace(",", "."));
  const product = await Product.findByIdAndUpdate(request.params.id, { price: value }, { new: true });
  if (!product) return response.status(404).json({ error: "Produto nÃ£o encontrado." });
  return response.json(publicProduct(product));
}));

const PERIODS = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: 0 };
app.get("/api/admin/reports", asyncRoute(async (request, response) => {
  const period = Object.hasOwn(PERIODS, request.query.period) ? request.query.period : "30d";
  const days = PERIODS[period];
  const since = new Date();
  if (days) {
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
  }
  const orders = await Order.find(days ? { createdAt: { $gte: since } } : {}).sort({ createdAt: 1 }).lean();
  const count = { pending: 0, delivered: 0, cancelled: 0 };
  let revenue = 0;
  let pendingValue = 0;
  const products = new Map();
  const categories = new Map();
  const daily = new Map();
  for (const order of orders) {
    count[order.status] += 1;
    const day = order.createdAt.toISOString().slice(0, 10);
    const entry = daily.get(day) || { date: day, orders: 0, revenue: 0 };
    entry.orders += 1;
    if (order.status === "pending") pendingValue += order.total;
    if (order.status === "delivered") {
      revenue += order.total;
      entry.revenue = roundMoney(entry.revenue + order.total);
      for (const item of order.items) {
        const p = products.get(item.name) || { name: item.name, quantity: 0, revenue: 0 };
        p.quantity += item.quantity;
        p.revenue = roundMoney(p.revenue + item.subtotal);
        products.set(item.name, p);
        const name = item.categoryName || "Sem categoria";
        const c = categories.get(name) || { name, quantity: 0, revenue: 0 };
        c.quantity += item.quantity;
        c.revenue = roundMoney(c.revenue + item.subtotal);
        categories.set(name, c);
      }
    }
    daily.set(day, entry);
  }
  response.json({
    period,
    totalOrders: orders.length,
    count,
    revenue: roundMoney(revenue),
    pendingValue: roundMoney(pendingValue),
    averageTicket: count.delivered ? roundMoney(revenue / count.delivered) : 0,
    topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    categories: [...categories.values()].sort((a, b) => b.revenue - a.revenue),
    daily: [...daily.values()],
  });
}));

let lastMaintenance = null;

async function runScheduledMaintenance() {
  try {
    const report = await runMaintenance({ dryRun: false, compact: true });
    lastMaintenance = report;
    const removed = Object.entries(report.removed).filter(([, count]) => count > 0);
    if (removed.length) {
      console.log("[manutenção]", removed.map(([key, count]) => `${key}=${count}`).join(" "), `| liberado ${report.freedBytes} bytes`);
    }
    return report;
  } catch (error) {
    console.error("Falha na manutenção automática do banco:", error.message);
    lastMaintenance = { error: error.message, finishedAt: new Date().toISOString() };
    return lastMaintenance;
  }
}

app.get("/api/admin/maintenance", (request, response) => {
  response.json({
    enabled: CLEANUP_ENABLED,
    intervalMinutes: CLEANUP_INTERVAL_MS / 60000,
    lastRun: lastMaintenance,
  });
});

app.post("/api/admin/maintenance/run", asyncRoute(async (request, response) => {
  const options = z.object({
    dryRun: z.enum(["true", "false"]).optional().default("false"),
    compact: z.enum(["true", "false"]).optional().default("true"),
  }).parse(request.body || {});
  const report = await runMaintenance({ dryRun: options.dryRun === "true", compact: options.compact === "true" });
  if (options.dryRun === "false") lastMaintenance = report;
  response.json(report);
}));

app.get("/api/admin/dashboard", asyncRoute(async (request, response) => {
  const [products, categories, featured] = await Promise.all([
    Product.countDocuments(),
    Category.countDocuments(),
    Product.countDocuments({ active: true, featured: true }),
  ]);
  response.json({ products, categories, featured });
}));

app.get("/api/admin/products", asyncRoute(async (request, response) => {
  const products = await Product.find().sort({ updatedAt: -1 }).lean();
  response.json(products.map(publicProduct).map((product, index) => ({
    ...product,
    active: products[index].active,
  })));
}));

const productFiles = upload.fields([{ name: "image", maxCount: 1 }, { name: "gallery", maxCount: MAX_GALLERY }]);

app.post("/api/admin/products", productFiles, asyncRoute(async (request, response) => {
  const input = parseProductInput(request.body);
  const category = await Category.findById(input.fields.categoryId);
  if (!category) return response.status(400).json({ error: "Selecione uma categoria vÃ¡lida." });
  const stored = [];
  try {
    const imageId = await storeImage(request.files?.image?.[0]);
    if (imageId) stored.push(imageId);
    const galleryIds = [];
    for (const file of request.files?.gallery || []) {
      const id = await storeImage(file);
      stored.push(id);
      galleryIds.push(id);
    }
    const product = await Product.create({ ...input.fields, categoryName: category.name, imageId, galleryIds });
    return response.status(201).json(publicProduct(product));
  } catch (error) {
    await Promise.all(stored.map((id) => removeImage(id).catch(() => {})));
    throw error;
  }
}));

app.put("/api/admin/products/:id", productFiles, asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Produto invÃ¡lido." });
  const input = parseProductInput(request.body);
  const category = await Category.findById(input.fields.categoryId);
  if (!category) return response.status(400).json({ error: "Selecione uma categoria vÃ¡lida." });
  const product = await Product.findById(request.params.id);
  if (!product) return response.status(404).json({ error: "Produto nÃ£o encontrado." });
  const oldImageId = product.imageId;
  const removedGallery = (product.galleryIds || []).filter((id) => input.removeGalleryIds.has(String(id)));
  const keptGallery = (product.galleryIds || []).filter((id) => !input.removeGalleryIds.has(String(id)));
  const newFiles = request.files?.gallery || [];
  if (keptGallery.length + newFiles.length > MAX_GALLERY) {
    return response.status(400).json({ error: `Cada produto aceita atÃ© ${MAX_GALLERY} fotos extras.` });
  }
  const stored = [];
  let newImageId = null;
  try {
    newImageId = await storeImage(request.files?.image?.[0]);
    if (newImageId) stored.push(newImageId);
    const addedGallery = [];
    for (const file of newFiles) {
      const id = await storeImage(file);
      stored.push(id);
      addedGallery.push(id);
    }
    Object.assign(product, input.fields, { categoryName: category.name });
    if (newImageId) product.imageId = newImageId;
    else if (input.removeImage) product.imageId = null;
    product.galleryIds = [...keptGallery, ...addedGallery];
    await product.save();
  } catch (error) {
    await Promise.all(stored.map((id) => removeImage(id).catch(() => {})));
    throw error;
  }
  const obsolete = [...removedGallery, ...((newImageId || input.removeImage) && oldImageId ? [oldImageId] : [])];
  for (const id of obsolete) {
    try {
      await removeImage(id);
    } catch (error) {
      console.error("NÃ£o foi possÃ­vel limpar a imagem substituÃ­da:", error);
    }
  }
  return response.json(publicProduct(product));
}));

app.delete("/api/admin/products/:id", asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Produto invÃ¡lido." });
  const product = await Product.findByIdAndDelete(request.params.id);
  if (!product) return response.status(404).json({ error: "Produto nÃ£o encontrado." });
  try {
    await Promise.all([product.imageId, ...(product.galleryIds || [])].map((id) => removeImage(id)));
  } catch (error) {
    console.error("NÃ£o foi possÃ­vel limpar a imagem do produto excluÃ­do:", error.message);
  }
  return response.json({ ok: true });
}));

app.get("/api/admin/categories", asyncRoute(async (request, response) => {
  const categories = await Category.find().sort({ order: 1, name: 1 }).lean();
  response.json(categories.map(({ _id, name, order }) => ({ id: _id, name, order })));
}));

app.post("/api/admin/categories", asyncRoute(async (request, response) => {
  const input = categoryInput.parse(request.body);
  const category = await Category.create(input);
  return response.status(201).json({ id: category.id, name: category.name, order: category.order });
}));

app.put("/api/admin/categories/:id", asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Categoria invÃ¡lida." });
  const input = categoryInput.parse(request.body);
  const category = await Category.findByIdAndUpdate(request.params.id, input, { new: true, runValidators: true });
  if (!category) return response.status(404).json({ error: "Categoria nÃ£o encontrada." });
  await Product.updateMany({ categoryId: category._id }, { $set: { categoryName: category.name } });
  return response.json({ id: category.id, name: category.name, order: category.order });
}));

app.delete("/api/admin/categories/:id", asyncRoute(async (request, response) => {
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Categoria invÃ¡lida." });
  if (await Product.exists({ categoryId: request.params.id })) {
    return response.status(409).json({ error: "Mova ou exclua os produtos desta categoria antes de removÃª-la." });
  }
  const category = await Category.findByIdAndDelete(request.params.id);
  if (!category) return response.status(404).json({ error: "Categoria nÃ£o encontrada." });
  return response.json({ ok: true });
}));

app.get("/api/admin/settings", asyncRoute(async (request, response) => {
  const settings = (await SiteSettings.findOne({ key: "site" }).lean()) || new SiteSettings().toObject();
  response.json(settings);
}));

app.put("/api/admin/settings", upload.fields([
  { name: "heroImage", maxCount: 1 },
  { name: "aboutImage", maxCount: 1 },
]), asyncRoute(async (request, response) => {
  const input = settingsInput.parse(request.body);
  const existing = await SiteSettings.findOne({ key: "site" });
  const previousImages = {
    heroImageId: existing?.heroImageId || null,
    aboutImageId: existing?.aboutImageId || null,
  };
  const files = request.files || {};
  const uploaded = [];
  try {
    if (files.heroImage?.[0]) uploaded.push(["heroImageId", await storeImage(files.heroImage[0])]);
    if (files.aboutImage?.[0]) uploaded.push(["aboutImageId", await storeImage(files.aboutImage[0])]);
  } catch (error) {
    await Promise.all(uploaded.map(([, id]) => removeImage(id)));
    throw error;
  }
  try {
    const changes = Object.fromEntries(uploaded);
    if (input.removeHeroImage && !changes.heroImageId) changes.heroImageId = null;
    if (input.removeAboutImage && !changes.aboutImageId) changes.aboutImageId = null;
    const settings = await SiteSettings.findOneAndUpdate(
      { key: "site" },
      { $set: { ...input, ...changes } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).catch(async (error) => {
      await Promise.all(uploaded.map(([, id]) => removeImage(id)));
      throw error;
    });
    for (const [field, id] of uploaded) {
      if (previousImages[field] && previousImages[field].toString() !== id.toString()) {
        try {
          await removeImage(previousImages[field]);
        } catch (error) {
          console.error("NÃ£o foi possÃ­vel limpar a imagem substituÃ­da:", error.message);
        }
      }
    }
    for (const field of ["heroImageId", "aboutImageId"]) {
      if (changes[field] === null && previousImages[field]) {
        try {
          await removeImage(previousImages[field]);
        } catch (error) {
          console.error("NÃ£o foi possÃ­vel limpar a imagem removida:", error.message);
        }
      }
    }
    return response.json({
      ...settings.toObject(),
      heroImageUrl: settings.heroImageId ? `/api/images/${settings.heroImageId}` : "",
      aboutImageUrl: settings.aboutImageId ? `/api/images/${settings.aboutImageId}` : "",
    });
  } catch (error) { throw error; }
}));

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "A imagem deve ter no mÃ¡ximo 5 MB." : "NÃ£o foi possÃ­vel processar o arquivo enviado." });
  }
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: error.issues[0]?.message || "Revise os campos informados." });
  }
  if (error.type === "entity.parse.failed") return response.status(400).json({ error: "O conteÃºdo enviado nÃ£o estÃ¡ em um formato vÃ¡lido." });
  if (error.code === 11000) return response.status(409).json({ error: "JÃ¡ existe um cadastro com esses dados." });
  if (error.name === "ValidationError" || error.name === "CastError") {
    return response.status(400).json({ error: "Revise os campos informados." });
  }
  if (error.status && error.status < 500) return response.status(error.status).json({ error: error.message });
  console.error("Erro interno na aplicaÃ§Ã£o:", error.message);
  return response.status(500).json({ error: "NÃ£o foi possÃ­vel concluir a solicitaÃ§Ã£o. Tente novamente." });
});

async function start() {
  if (!MONGODB_URI) throw new Error("Defina MONGODB_URI no arquivo .env.");
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error("Defina SESSION_SECRET com pelo menos 32 caracteres no arquivo .env.");
  }
  await ensureReady();
  app.listen(PORT, () => console.log(`Herbal Suplementos disponível em ${SITE_ORIGIN}`));

  if (CLEANUP_ENABLED) {
    // ManutenÃ§Ã£o automÃ¡tica: relata no log e remove o que estÃ¡ sem uso.
    runScheduledMaintenance();
    const timer = setInterval(runScheduledMaintenance, CLEANUP_INTERVAL_MS);
    timer.unref(); // nÃ£o impede o processo de encerrar
  } else {
    console.log("ManutenÃ§Ã£o automÃ¡tica do banco desativada (CLEANUP_ENABLED=false).");
  }
}

if (require.main === module) {
  start().catch((error) => {
    console.error("NÃ£o foi possÃ­vel iniciar o servidor:", error.message);
    process.exitCode = 1;
  });
}

// O Vercel detecta este arquivo como app Express e invoca o próprio `app` como
// handler; por isso o módulo exporta o app diretamente. Os demais itens ficam
// anexados para os testes.
module.exports = app;
Object.assign(module.exports, {
  app,
  adminUsernameInput,
  imageType,
  productInput,
  settingsInput,
  Category,
  SiteSettings,
  Admin,
  Order,
  orderInput,
  codeInput,
  generateOrderCode,
});
