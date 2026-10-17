const sharp = require("sharp");

// As imagens ficam dentro do banco (GridFS), então cada byte economizado conta
// duas vezes: no armazenamento e no tráfego. Redimensionamos para o maior
// tamanho realmente exibido no site e recomprimimos em WebP, que é bem menor
// que PNG/JPEG na mesma qualidade percebida.
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1600;
const WEBP_QUALITY = 78;
const WEBP_EFFORT = 4;
const ALREADY_LIGHT_BYTES = 120 * 1024;

function extensionFor(format) {
  if (format === "jpeg") return "jpg";
  return format || "png";
}

function contentTypeFor(format) {
  if (!format) return "image/png";
  return `image/${format === "jpg" ? "jpeg" : format}`;
}

/**
 * Redimensiona e recomprime uma imagem recebida pelo upload.
 * Nunca lança: se a otimização falhar, devolve o buffer original para não
 * impedir o cadastro do produto.
 *
 * @param {Buffer} buffer conteúdo do arquivo enviado
 * @returns {Promise<object>} buffer final e metadados da otimização
 */
async function optimizeImage(buffer) {
  const originalBytes = buffer.length;
  try {
    const image = sharp(buffer, { failOn: "none", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const originalFormat = metadata.format;

    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const needsResize = width > MAX_WIDTH || height > MAX_HEIGHT;

    // Imagem pequena e já leve: não compensa mexer.
    if (!needsResize && originalBytes <= ALREADY_LIGHT_BYTES) {
      return {
        buffer,
        contentType: contentTypeFor(originalFormat),
        extension: extensionFor(originalFormat),
        originalBytes,
        optimizedBytes: originalBytes,
        changed: false,
        warning: "",
      };
    }

    const optimized = await image
      .rotate() // respeita a orientação EXIF
      .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer();

    // Evita trocar por um arquivo maior que o original.
    const saving = 1 - optimized.length / originalBytes;
    const worthIt = originalFormat === "webp" ? saving > 0.08 : optimized.length < originalBytes;
    if (!worthIt) {
      return {
        buffer,
        contentType: contentTypeFor(originalFormat),
        extension: extensionFor(originalFormat),
        originalBytes,
        optimizedBytes: originalBytes,
        changed: false,
        warning: "",
      };
    }

    return {
      buffer: optimized,
      contentType: "image/webp",
      extension: "webp",
      originalBytes,
      optimizedBytes: optimized.length,
      changed: true,
      warning: "",
    };
  } catch (error) {
    return {
      buffer,
      contentType: "image/png",
      extension: "png",
      originalBytes,
      optimizedBytes: originalBytes,
      changed: false,
      warning: `Não foi possível otimizar a imagem (${error.message}); o arquivo original foi mantido.`,
    };
  }
}

module.exports = { optimizeImage, MAX_WIDTH, MAX_HEIGHT, WEBP_QUALITY };
