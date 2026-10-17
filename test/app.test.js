const test = require("node:test");
const assert = require("node:assert/strict");
const { app, adminUsernameInput, imageType, productInput, settingsInput, orderInput, codeInput, generateOrderCode } = require("../server");

test("detecta PNG, JPEG e WebP pela assinatura do arquivo", () => {
  assert.equal(imageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).contentType, "image/png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0x00])).contentType, "image/jpeg");
  assert.equal(imageType(Buffer.from("RIFF0000WEBP")).contentType, "image/webp");
  assert.equal(imageType(Buffer.from("<svg></svg>")), null);
});

test("valida campos obrigatÃ³rios, preÃ§o e opÃ§Ãµes de produto", () => {
  const valid = {
    name: "ChÃ¡ de Hibisco",
    description: "Folhas para infusÃ£o",
    categoryId: "0123456789abcdef01234567",
    price: "29,90",
    active: "true",
  };
  assert.equal(productInput.safeParse(valid).success, true);
  assert.equal(productInput.safeParse({ ...valid, price: "-1" }).success, false);
  assert.equal(productInput.safeParse({ ...valid, categoryId: "not-an-id" }).success, false);
  assert.equal(productInput.safeParse({ ...valid, name: "" }).success, false);
});

test("aceita apenas URLs HTTP(S) para links externos configurÃ¡veis", () => {
  const valid = {
    heroTitle: "Mais natureza no seu dia",
    whatsapp: "553899662812",
    mapUrl: "https://maps.google.com/",
  };
  assert.equal(settingsInput.safeParse(valid).success, true);
  assert.equal(settingsInput.safeParse({ ...valid, mapUrl: "javascript:alert(1)" }).success, false);
  assert.equal(settingsInput.safeParse({ ...valid, whatsapp: "abc" }).success, false);
});

test("valida nomes de usuÃ¡rio administrativos e normaliza caixa no provisionamento", () => {
  assert.equal(adminUsernameInput.safeParse("ADM").success, true);
  assert.equal(adminUsernameInput.safeParse("dev_2").success, true);
  assert.equal(adminUsernameInput.safeParse("nome de usuÃ¡rio").success, false);
  assert.equal(adminUsernameInput.safeParse("nome@dominio.com").success, false);
});

test("bloqueia acesso anÃ´nimo Ã s APIs administrativas e nÃ£o publica o cÃ³digo do servidor", async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adminResponse = await fetch(`${origin}/api/admin/dashboard`);
  const writeResponse = await fetch(`${origin}/api/admin/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Intruso" }),
  });
  const sourceResponse = await fetch(`${origin}/server.js`);
  const pageResponse = await fetch(origin);
  const styleResponse = await fetch(`${origin}/css/style.css`);
  const publicScriptResponse = await fetch(`${origin}/Js/app.js`);
  const adminPageResponse = await fetch(`${origin}/admin/`);
  assert.equal(adminResponse.status, 401);
  assert.equal(writeResponse.status, 401);
  assert.equal(sourceResponse.status, 404);
  assert.equal(pageResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  assert.equal(publicScriptResponse.status, 200);
  assert.equal(adminPageResponse.status, 200);
});

test("valida pedidos e códigos de pedido", () => {
  const id = "a".repeat(24);
  assert.equal(orderInput.safeParse({ items: [{ productId: id, quantity: 2 }] }).success, true);
  assert.equal(orderInput.safeParse({ items: [] }).success, false);
  assert.equal(orderInput.safeParse({ items: [{ productId: id, quantity: 100 }] }).success, false);
  assert.equal(orderInput.safeParse({ items: [{ productId: "x", quantity: 1 }] }).success, false);
  for (let i = 0; i < 50; i += 1) assert.equal(codeInput.safeParse(generateOrderCode()).success, true);
  assert.equal(codeInput.parse("hb-abcd-2345"), "HB-ABCD-2345");
  assert.equal(codeInput.safeParse("qualquer").success, false);
});

test("bloqueia acesso anônimo a pedidos e relatórios administrativos", async (context) => {
  const server = app.listen(0);
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/api/admin/orders", "/api/admin/orders/code/HB-AAAA-BBBB", "/api/admin/reports"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 401);
  }
});
