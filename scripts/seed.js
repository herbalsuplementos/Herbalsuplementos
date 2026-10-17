require("dotenv").config();

const mongoose = require("mongoose");
const { Category, SiteSettings } = require("../server");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("Defina MONGODB_URI no arquivo .env.");
  await mongoose.connect(process.env.MONGODB_URI);

  await SiteSettings.updateOne(
    { key: "site" },
    { $setOnInsert: {} },
    { upsert: true, setDefaultsOnInsert: true },
  );

  if (await Category.estimatedDocumentCount() === 0) {
    await Category.insertMany([
      { name: "Chás e infusões", order: 10 },
      { name: "Produtos naturais", order: 20 },
      { name: "Suplementos", order: 30 },
      { name: "Produtos em pó", order: 40 },
      { name: "Grãos e sementes", order: 50 },
      { name: "Temperos naturais", order: 60 },
    ]);
  }
  console.log("Banco Herbal inicializado com configurações padrão e categorias vazias para cadastro.");
}

main()
  .catch((error) => {
    console.error("Não foi possível inicializar o banco:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
