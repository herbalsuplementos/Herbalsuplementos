(() => {
  const KEY = "herbal.consent.v1";
  const YEAR = 365 * 24 * 60 * 60 * 1000;
  const BODY_CLASS = "cookie-banner-open";

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      return saved && Date.now() - saved.at < YEAR ? saved : null;
    } catch { return null; }
  }

  function write() {
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now() })); } catch { /* armazenamento indisponível */ }
  }

  function syncBodyState(open) {
    document.body.classList.toggle(BODY_CLASS, open);
  }

  function show() {
    if (document.getElementById("cookie-banner")) {
      syncBodyState(true);
      return;
    }
    const banner = document.createElement("aside");
    banner.id = "cookie-banner";
    banner.className = "cookie-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Aviso de cookies");
    const text = document.createElement("p");
    text.append("Usamos apenas armazenamento essencial (carrinho e preferências) para o site funcionar. Não usamos cookies de publicidade nem rastreamento. Veja a ");
    for (const [href, label, suffix] of [["/cookies", "Política de Cookies", ", a "], ["/privacidade", "Política de Privacidade", " e os "], ["/termos", "Termos de Uso", "."]]) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      text.append(link, suffix);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = "Entendi";
    button.addEventListener("click", () => {
      write();
      syncBodyState(false);
      banner.remove();
    });
    banner.append(text, button);
    document.body.append(banner);
    syncBodyState(true);
  }

  syncBodyState(false);
  if (!read()) show();
  document.getElementById("reset-consent")?.addEventListener("click", () => {
    try { localStorage.removeItem(KEY); } catch { /* ignorado */ }
    show();
  });
})();
