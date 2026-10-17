require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { Admin, adminUsernameInput } = require("../server");

async function main() {
  const usernameResult = adminUsernameInput.safeParse(process.env.ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  const minimumPasswordLength = process.env.ALLOW_WEAK_ADMIN_PASSWORD === "true" ? 8 : 12;
  if (!usernameResult.success || !password || password.length < minimumPasswordLength || password.length > 200) {
    throw new Error(`Defina ADMIN_USERNAME e ADMIN_PASSWORD (mínimo de ${minimumPasswordLength} caracteres) no ambiente apenas durante esta operação.`);
  }
  if (!process.env.MONGODB_URI) throw new Error("Defina MONGODB_URI no arquivo .env.");
  await mongoose.connect(process.env.MONGODB_URI);
  const admins = mongoose.connection.collection("admins");
  const legacyAdmins = await admins.countDocuments({ username: { $exists: false } });
  if (legacyAdmins > 0) {
    throw new Error("Há contas antigas sem nome de usuário. Migre-as antes de provisionar novas contas.");
  }
  const indexes = await admins.indexes();
  for (const legacyIndex of ["email_1", "role_1"]) {
    if (indexes.some((index) => index.name === legacyIndex)) await admins.dropIndex(legacyIndex);
  }
  await admins.createIndex({ username: 1 }, { unique: true });
  const username = usernameResult.data.toUpperCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const existingAdmin = await Admin.findOne({ username });
  if (existingAdmin) {
    if (process.env.RESET_ADMIN_PASSWORD !== "true") {
      throw new Error("Esse nome de usuário já está cadastrado. Para trocar a senha, defina RESET_ADMIN_PASSWORD=true.");
    }
    await Admin.updateOne({ _id: existingAdmin._id }, { $set: { passwordHash } });
    console.log(`Senha da conta ${username} atualizada. Remova as variáveis administrativas do ambiente após o uso.`);
    return;
  }
  await Admin.create({ username, passwordHash, role: "admin" });
  console.log(`Conta administrativa ${username} criada. Remova ADMIN_USERNAME e ADMIN_PASSWORD do ambiente após o uso.`);
}

main()
  .catch((error) => {
    console.error("Não foi possível criar o administrador:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
