(() => {
  const state = { products: [], categories: [], categoryId: "all", search: "", whatsapp: "553899662812" };
  const byId = (id) => document.getElementById(id);

  function setImage(element, url) {
    if (!url) return;
    const image = element.querySelector("img");
    image.src = url;
    image.hidden = false;
    element.classList.add("has-image");
  }

  const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
  const hasPrice = (product) => product.price !== null && product.price !== undefined && product.price !== "";
  const CART_KEY = "herbal.cart.v1";
  const ORDER_KEY = "herbal.order.v1";
  let cart = [];
  let lastOrder = null;
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    if (Array.isArray(saved)) cart = saved.filter((line) => line && typeof line.id === "string" && Number.isInteger(line.quantity) && line.quantity > 0).slice(0, 30);
  } catch { cart = []; }
  try {
    const stored = JSON.parse(localStorage.getItem(ORDER_KEY) || "null");
    if (stored && typeof stored.code === "string" && /^HB-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(stored.code)) lastOrder = stored;
  } catch { lastOrder = null; }

  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* armazenamento indisponível */ }
    renderCart();
  }

  function cartLines() {
    return cart.map((line) => ({ line, product: state.products.find((product) => String(product.id) === line.id) }))
      .filter((entry) => entry.product && hasPrice(entry.product));
  }

  function addToCart(product, button) {
    const line = cart.find((item) => item.id === String(product.id));
    if (line) line.quantity = Math.min(99, line.quantity + 1);
    else cart.push({ id: String(product.id), quantity: 1 });
    saveCart();
    if (button) {
      const original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.textContent = "Adicionado ✓";
      window.setTimeout(() => { button.textContent = original; }, 1200);
    }
  }

  function changeQuantity(id, delta) {
    const line = cart.find((item) => item.id === id);
    if (!line) return;
    line.quantity += delta;
    if (line.quantity < 1) cart = cart.filter((item) => item.id !== id);
    line.quantity = Math.min(99, line.quantity);
    saveCart();
  }

  function renderCart() {
    const entries = cartLines();
    const count = entries.reduce((sum, { line }) => sum + line.quantity, 0);
    byId("cart-count").textContent = String(count);
    byId("cart-count").hidden = count === 0;
    byId("cart-checkout").disabled = count === 0;
    const container = byId("cart-items");
    container.replaceChildren();
    let total = 0;
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "cart-empty";
      empty.textContent = "Seu carrinho está vazio. Adicione produtos do catálogo.";
      container.append(empty);
    }
    for (const { line, product } of entries) {
      total += product.price * line.quantity;
      const wrap = document.createElement("div");
      wrap.className = "cart-line";
      const name = document.createElement("strong");
      name.textContent = product.name;
      const row = document.createElement("div");
      row.className = "cart-line-row";
      const qty = document.createElement("div");
      qty.className = "qty";
      const minus = document.createElement("button");
      minus.type = "button";
      minus.textContent = "−";
      minus.setAttribute("aria-label", `Diminuir ${product.name}`);
      minus.addEventListener("click", () => changeQuantity(line.id, -1));
      const value = document.createElement("span");
      value.textContent = String(line.quantity);
      const plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "+";
      plus.setAttribute("aria-label", `Aumentar ${product.name}`);
      plus.addEventListener("click", () => changeQuantity(line.id, 1));
      qty.append(minus, value, plus);
      const subtotal = document.createElement("span");
      subtotal.textContent = money(product.price * line.quantity);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cart-remove";
      remove.textContent = "Remover";
      remove.addEventListener("click", () => changeQuantity(line.id, -999));
      row.append(qty, subtotal, remove);
      wrap.append(name, row);
      container.append(wrap);
    }
    byId("cart-total").textContent = money(total);
  }

  function toggleCart(open) {
    byId("cart-drawer").hidden = !open;
    byId("cart-backdrop").hidden = !open;
    byId("cart-drawer").setAttribute("aria-hidden", String(!open));
    if (open) byId("cart-close").focus();
  }

  function showOrderCode(order) {
    byId("order-code").textContent = order.code;
    byId("order-total").textContent = money(order.total);
    byId("last-order").hidden = false;
  }

  function renderLastOrder() {
    if (!lastOrder) return;
    showOrderCode(lastOrder);
  }

  async function checkout() {
    const entries = cartLines();
    const error = byId("cart-error");
    error.hidden = true;
    if (!entries.length) return;
    const button = byId("cart-checkout");
    button.disabled = true;
    button.textContent = "Gerando pedido...";
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          customerName: byId("cart-customer").value.trim(),
          items: entries.map(({ line }) => ({ productId: line.id, quantity: line.quantity })),
        }),
      });
      const order = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(order.error || "Não foi possível gerar o pedido.");
      const lines = order.items.map((item) => `• ${item.quantity}x ${item.name} — ${money(item.subtotal)}`);
      const message = [
        "Olá! Gostaria de separar o meu pedido na Herbal Suplementos.",
        "Retirada na loja (sem entrega).",
        order.customerName ? `Cliente: ${order.customerName}` : "",
        "",
        ...lines,
        "",
        `Total: ${money(order.total)}`,
        "Vou informar o código do pedido na loja.",
      ].filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== "")).join("\n");
      lastOrder = { code: order.code, total: order.total, at: Date.now() };
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(lastOrder)); } catch { /* armazenamento indisponível */ }
      cart = [];
      saveCart();
      toggleCart(false);
      showOrderCode(lastOrder);
      const digits = String(state.whatsapp).replace(/\D/g, "");
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      button.textContent = "Finalizar no WhatsApp";
      button.disabled = cartLines().length === 0;
    }
  }

  function setWhatsApp(element, number, text) {
    const digits = String(number || state.whatsapp).replace(/\D/g, "");
    if (!/^\d{10,15}$/.test(digits)) return;
    element.href = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  }

  function renderFilters() {
    const container = byId("category-filters");
    container.replaceChildren();
    const filters = [{ id: "all", name: "Todos" }, ...state.categories];
    for (const category of filters) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-button";
      button.textContent = category.name;
      button.setAttribute("aria-pressed", String(state.categoryId === category.id));
      button.addEventListener("click", () => {
        state.categoryId = category.id;
        renderFilters();
        renderProducts();
      });
      container.append(button);
    }
  }

  const modal = { images: [], index: 0, product: null };

  function showModalImage(index) {
    const count = modal.images.length;
    if (!count) return;
    modal.index = (index + count) % count;
    const image = byId("modal-image");
    image.src = modal.images[modal.index];
    image.alt = modal.product.name;
    image.hidden = false;
    byId("modal-placeholder").hidden = true;
    byId("modal-thumbs").querySelectorAll("button").forEach((thumb, position) => thumb.classList.toggle("active", position === modal.index));
  }

  function openProduct(product) {
    modal.product = product;
    modal.images = [product.imageUrl, ...(product.gallery || []).map((item) => item.url)].filter(Boolean);
    modal.index = 0;
    byId("modal-category").textContent = product.category || "Produtos naturais";
    byId("modal-title").textContent = product.name;
    byId("modal-price").textContent = hasPrice(product) ? money(product.price) : "Consulte o preço";
    byId("modal-description").textContent = product.description || "Consulte a equipe para saber mais sobre este produto.";
    const thumbs = byId("modal-thumbs");
    thumbs.replaceChildren();
    modal.images.forEach((url, position) => {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.setAttribute("aria-label", `Ver foto ${position + 1}`);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      thumb.append(img);
      thumb.addEventListener("click", () => showModalImage(position));
      thumbs.append(thumb);
    });
    thumbs.hidden = modal.images.length < 2;
    byId("modal-prev").hidden = byId("modal-next").hidden = modal.images.length < 2;
    byId("modal-image").hidden = !modal.images.length;
    byId("modal-placeholder").hidden = modal.images.length > 0;
    showModalImage(0);
    const add = byId("modal-add");
    add.hidden = !hasPrice(product);
    add.textContent = "Adicionar ao carrinho";
    setWhatsApp(byId("modal-whatsapp"), state.whatsapp, `Olá! Quero saber mais sobre: ${product.name}`);
    byId("product-modal").showModal();
  }

  function makeCard(product) {
    const article = document.createElement("article");
    article.className = "product-card";
    article.addEventListener("click", (event) => {
      if (!event.target.closest("a, .add-button")) openProduct(product);
    });
    const visual = document.createElement("div");
    visual.className = "product-image";
    if (product.imageUrl) {
      const image = document.createElement("img");
      image.src = product.imageUrl;
      image.alt = product.name;
      image.loading = "lazy";
      image.width = 640;
      image.height = 580;
      image.addEventListener("error", () => {
        image.remove();
        const placeholder = document.createElement("span");
        placeholder.className = "product-placeholder";
        placeholder.textContent = "H";
        placeholder.setAttribute("aria-hidden", "true");
        visual.append(placeholder);
      }, { once: true });
      visual.append(image);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "product-placeholder";
      placeholder.textContent = "H";
      placeholder.setAttribute("aria-hidden", "true");
      visual.append(placeholder);
    }
    const badges = document.createElement("div");
    badges.className = "product-badges";
    for (const [enabled, text] of [[product.promotion, "Promoção"], [product.new, "Novidade"], [product.featured, "Destaque"]]) {
      if (!enabled) continue;
      const badge = document.createElement("span");
      badge.className = "product-badge";
      badge.textContent = text;
      badges.append(badge);
    }
    visual.append(badges);

    const body = document.createElement("div");
    body.className = "product-body";
    const category = document.createElement("span");
    category.className = "card-categoria";
    category.textContent = product.category || "Produtos naturais";
    const title = document.createElement("h3");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "product-open";
    openButton.textContent = product.name;
    openButton.setAttribute("aria-label", `Ver detalhes de ${product.name}`);
    title.append(openButton);
    const description = document.createElement("p");
    description.textContent = product.description || "Consulte a equipe para saber mais.";
    const footer = document.createElement("div");
    footer.className = "product-footer";
    const price = document.createElement("span");
    price.className = "product-price";
    price.textContent = product.price !== null && product.price !== undefined && product.price !== ""
      ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.price)
      : "Consulte";
    const link = document.createElement("a");
    link.className = "product-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Consultar ↗";
    setWhatsApp(link, state.whatsapp, `Olá! Quero saber mais sobre: ${product.name}`);
    const actions = document.createElement("div");
    actions.className = "product-actions";
    if (hasPrice(product)) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-button";
      add.textContent = "Adicionar";
      add.addEventListener("click", () => addToCart(product, add));
      actions.append(add);
    }
    actions.append(link);
    footer.append(price, actions);
    body.append(category, title, description, footer);
    article.append(visual, body);
    return article;
  }

  function renderProducts() {
    const container = byId("lista-produtos");
    container.replaceChildren();
    const matches = state.products.filter((product) => {
      const categoryMatch = state.categoryId === "all" || String(product.categoryId) === String(state.categoryId);
      const searchMatch = `${product.name} ${product.category || ""}`.toLocaleLowerCase("pt-BR").includes(state.search);
      return categoryMatch && searchMatch;
    });
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("h3");
      const message = document.createElement("p");
      title.textContent = state.products.length ? "Nenhum produto encontrado" : "Nosso catálogo está sendo preparado";
      message.textContent = state.products.length ? "Tente mudar o termo de busca ou escolha outra categoria." : "Em breve, novidades por aqui. Fale com a equipe para consultar os produtos disponíveis.";
      empty.append(title, message);
      container.append(empty);
      return;
    }
    container.append(...matches.map(makeCard));
  }

  function applySettings(settings) {
    byId("topbar").textContent = settings.topbar || "";
    byId("hero-title").textContent = settings.heroTitle || "Mais natureza no seu dia a dia";
    byId("hero-text").textContent = settings.heroText || "";
    byId("about-title").textContent = settings.aboutTitle || "Cuidado natural, atendimento próximo";
    byId("about-text").textContent = settings.aboutText || "";
    setImage(byId("hero-image"), settings.heroImageUrl);
    setImage(byId("about-image"), settings.aboutImageUrl);
    state.whatsapp = settings.whatsapp || state.whatsapp;
    for (const id of ["header-whatsapp", "hero-whatsapp", "catalog-whatsapp", "about-whatsapp", "contact-whatsapp", "whatsapp-float"]) {
      setWhatsApp(byId(id), state.whatsapp, "Olá! Gostaria de conhecer os produtos da Herbal Suplementos.");
    }
    byId("contact-phone").textContent = settings.phone || "Chame no WhatsApp";
    byId("contact-phone").href = settings.phone ? `tel:${settings.phone.replace(/[^\d+]/g, "")}` : `https://wa.me/${state.whatsapp}`;
    byId("contact-address").textContent = settings.address || "Consulte nossa equipe pelo WhatsApp";
    byId("contact-hours").textContent = settings.hours || "Consulte os horários de atendimento";
    if (settings.mapUrl) {
      byId("map-link").href = settings.mapUrl;
      byId("map-link").hidden = false;
    }
    const socialLinks = [
      ["instagram-link", settings.instagram || "https://www.instagram.com/herbalsuplementos.terapiaervas/"],
      ["facebook-link", settings.facebook],
    ];
    for (const [id, url] of socialLinks) {
      if (url) {
        byId(id).href = url;
        byId(id).hidden = false;
      }
    }
  }

  async function load() {
    const status = byId("catalog-status");
    try {
      const response = await fetch("/api/site", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Não foi possível carregar o catálogo.");
      const data = await response.json();
      state.products = Array.isArray(data.products) ? data.products : [];
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      applySettings(data.settings || {});
      renderFilters();
      renderProducts();
      renderCart();
      renderLastOrder();
      status.textContent = "";
    } catch (error) {
      status.textContent = "Não foi possível carregar as informações agora. Tente novamente mais tarde.";
      state.products = [];
      state.categories = [];
      renderProducts();
      console.error("Falha ao carregar o conteúdo público:", error);
    }
  }

  byId("product-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLocaleLowerCase("pt-BR");
    renderProducts();
  });
  byId("menu-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const nav = byId("main-nav");
    const isOpen = nav.classList.toggle("open");
    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute("aria-label", isOpen ? "Fechar menu" : "Abrir menu");
  });
  byId("main-nav").addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      byId("main-nav").classList.remove("open");
      byId("menu-toggle").setAttribute("aria-expanded", "false");
    }
  });
  byId("cart-open").addEventListener("click", () => toggleCart(true));
  const productModal = byId("product-modal");
  byId("modal-close").addEventListener("click", () => productModal.close());
  productModal.addEventListener("click", (event) => { if (event.target === productModal) productModal.close(); });
  byId("modal-prev").addEventListener("click", () => showModalImage(modal.index - 1));
  byId("modal-next").addEventListener("click", () => showModalImage(modal.index + 1));
  byId("modal-add").addEventListener("click", (event) => addToCart(modal.product, event.currentTarget));
  productModal.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") showModalImage(modal.index - 1);
    if (event.key === "ArrowRight") showModalImage(modal.index + 1);
  });
  byId("cart-close").addEventListener("click", () => toggleCart(false));
  byId("cart-backdrop").addEventListener("click", () => toggleCart(false));
  byId("cart-checkout").addEventListener("click", checkout);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") toggleCart(false); });
  byId("copyright-year").textContent = String(new Date().getFullYear());
  load();
})();
