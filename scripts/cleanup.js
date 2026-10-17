require("dotenv").config();

const mongoose = require("mongoose");
const { runMaintenance } = require("../lib/maintenance");

const HUMAN = new Intl.NumberFormat("pt-BR");

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function printReport(report) {
  const mode = report.dryRun ? "SIMULAÇÃO (nada foi apagado)" : "LIMPEZA EXECUTADA";
  console.log(`\n=== Manutenção do banco — ${mode} ===`);
  console.log(`Bucket de imagens: ${report.bucket}`);
  console.log(`Imagens em uso (preservadas): ${HUMAN.format(report.imagesKept)}`);
  console.log(`Tamanho total das imagens: ${formatBytes(report.imageBytesTotal)}`);

  const removed = report.removed;
  const lines = [
    ["Imagens órfãs (sem uso)", removed.images, formatBytes(removed.imageBytes)],
    ["Imagens corrompidas (sem blocos)", removed.emptyImageFiles],
    ["Blocos soltos (upload interrompido)", removed.chunks],
    ["Sessões expiradas", removed.sessionsExpired],
    ["Pedidos abandonados", removed.ordersAbandoned],
    ["Pedidos anônimos antigos", removed.ordersAnonymous],
    ["Contas de admin do formato antigo", removed.legacyAdmins],
  ];
  console.log("\n--- Removido ---");
  for (const [label, count, size] of lines) {
    if (!count) continue;
    console.log(`${label}: ${HUMAN.format(count)}${size ? ` (${size})` : ""}`);
  }
  const total = lines.reduce((sum, [, count]) => sum + (count || 0), 0);
  if (!total) console.log("Nada para remover. O banco já está limpo.");

  if (report.freedBytes) console.log(`\nEspaço liberado em imagens: ${formatBytes(report.freedBytes)}`);
  if (report.compaction.redundantIndexes.length) {
    console.log(`Índices redundantes removidos: ${report.compaction.redundantIndexes.join(", ")}`);
  }
  if (report.warnings.length) {
    console.log("\n--- Avisos ---");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  console.log("");
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("Defina MONGODB_URI no arquivo .env.");

  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--simular");
  const withCompact = !process.argv.includes("--no-compact");

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const report = await runMaintenance({ dryRun, compact: withCompact });
    printReport(report);
    if (dryRun) console.log("Dica: rode `npm run cleanup` para aplicar de verdade.\n");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("Não foi possível concluir a manutenção:", error.message);
  process.exitCode = 1;
});
