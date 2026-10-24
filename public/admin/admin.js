(() => {
  const state = { csrf: "", products: [], categories: [], settings: {} };
  const byId = (id) => document.getElementById(id);
  const form = byId("product-form");
  const dialog = byId("product-dialog");
  const titles = { dashboard: "Visão geral", products: "Produtos", categories: "Categorias", orders: "Pedidos", reports: "Relatórios", site: "Personalizar site", maintenance: "Manutenção do banco" };

  async function csrfToken() {
    const response = await fetch("/api/csrf", { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível iniciar a sessão.");
    state.csrf = result.token;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        "X-CSRF-Token": state.csrf,
        ...(options.headers || {}),
      },
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
    return data;
  }

  function showNotice(message, isError = false) {
    const notice = byId("notice");
    notice.textContent = message;
    notice.classList.toggle("error", isError);
    notice.hidden = !message;
    if (message) {
      window.clearTimeout(showNotice.timer);
      showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 6000);
    }
  }

  async function uploadRequest(url, data, progress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const method = url.includes("/products/") || url.endsWith("/settings") ? "PUT" : "POST";
      request.open(method, url);
      request.withCredentials = true;
      request.setRequestHeader("X-CSRF-Token", state.csrf);
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) progress.textContent = `Enviando imagem: ${Math.round(event.loaded / event.total * 100)}%`;
      });
      request.addEventListener("load", () => {
        let result;
        try { result = JSON.parse(request.responseText || "{}"); } catch { result = {}; }
        if (request.status >= 200 && request.status < 300) resolve(result);
        else reject(new Error(result.error || "Falha ao enviar os dados."));
      });
      request.addEventListener("error", () => reject(new Error("Falha de conexão. Verifique sua internet e tente novamente.")));
      request.addEventListener("abort", () => reject(new Error("Envio cancelado.")));
      request.send(data);
    });
  }

  function showLogin() {
    byId("admin-layout").hidden = true;
    byId("login-screen").hidden = false;
  }

  function showAdmin() {
    byId("login-screen").hidden = true;
    byId("admin-layout").hidden = false;
  }

  function activateView(view) {
    for (const panel of document.querySelectorAll(".view-panel")) panel.hidden = panel.id !== `view-${view}`;
    for (const button of document.querySelectorAll(".nav-item")) button.classList.toggle("active", button.dataset.view === view);
    byId("page-title").textContent = titles[view];
    byId("sidebar").classList.remove("open");
    byId("mobile-menu").setAttribute("aria-expanded", "false");
    if (view === "dashboard") loadDashboard();
    if (view === "products") loadProducts();
    if (view === "categories") loadCategories();
    if (view === "orders") loadOrders();
    if (view === "reports") loadReports();
    if (view === "site") loadSettings();
    if (view === "maintenance") loadMaintenance();
  }

  async function loadDashboard() {
    try {
      const data = await api("/api/admin/dashboard");
      byId("stat-products").textContent = data.products;
      byId("stat-categories").textContent = data.categories;
      byId("stat-featured").textContent = data.featured;
    } catch (error) { showNotice(error.message, true); }
  }

  function fillCategorySelect(select, selected = "") {
    select.replaceChildren();
    for (const category of state.categories) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      option.selected = String(category.id) === String(selected);
      select.append(option);
    }
  }

  async function loadCategories() {
    try {
      state.categories = await api("/api/admin/categories");
      renderCategories();
      fillCategorySelect(byId("product-category-select"));
      const filter = byId("product-filter-category");
      const current = filter.value;
      filter.replaceChildren(new Option("Todas as categorias", ""));
      for (const category of state.categories) filter.add(new Option(category.name, category.id));
      filter.value = current;
    } catch (error) { showNotice(error.message, true); }
  }

  function renderCategories() {
    const list = byId("category-list");
    list.replaceChildren();
    byId("categories-empty").hidden = state.categories.length > 0;
    for (const category of state.categories) {
      const row = document.createElement("div");
      row.className = "category-row";
      const name = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = category.name;
      const order = document.createElement("small");
      order.textContent = `Ordem: ${category.order}`;
      name.append(title, order);
      const actions = document.createElement("div");
      actions.className = "category-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Editar";
      edit.addEventListener("click", () => {
        byId("category-id").value = category.id;
        byId("category-name").value = category.name;
        byId("category-order").value = category.order;
        byId("category-save").textContent = "Salvar alterações";
        byId("category-cancel").hidden = false;
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Excluir";
      remove.addEventListener("click", () => removeCategory(category));
      actions.append(edit, remove);
      row.append(name, actions);
      list.append(row);
    }
  }

  async function removeCategory(category) {
    if (!window.confirm(`Excluir a categoria "${category.name}"? Produtos vinculados impedem a exclusão.`)) return;
    try {
      await api(`/api/admin/categories/${category.id}`, { method: "DELETE" });
      showNotice("Categoria excluída.");
      await loadCategories();
    } catch (error) { showNotice(error.message, true); }
  }

  function filteredProducts() {
    const search = byId("product-filter-search").value.trim().toLocaleLowerCase("pt-BR");
    const categoryId = byId("product-filter-category").value;
    const active = byId("product-filter-active").value;
    return state.products.filter((product) =>
      (!search || `${product.name} ${product.category}`.toLocaleLowerCase("pt-BR").includes(search)) &&
      (!categoryId || String(product.categoryId) === categoryId) &&
      (!active || String(product.active) === active));
  }

  async function loadProducts() {
    try {
      const [products, categories] = await Promise.all([api("/api/admin/products"), api("/api/admin/categories")]);
      state.products = products;
      state.categories = categories;
      fillCategorySelect(byId("product-category-select"));
      const filter = byId("product-filter-category");
      const current = filter.value;
      filter.replaceChildren(new Option("Todas as categorias", ""));
      for (const category of categories) filter.add(new Option(category.name, category.id));
      filter.value = current;
      renderProducts();
    } catch (error) { showNotice(error.message, true); }
  }

  function renderProducts() {
    const table = byId("products-table");
    table.replaceChildren();
    const products = filteredProducts();
    byId("products-empty").hidden = products.length > 0;
    for (const product of products) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const nameWrap = document.createElement("div");
      nameWrap.className = "table-product";
      if (product.imageUrl) {
        const image = document.createElement("img");
        image.src = product.imageUrl;
        image.alt = "";
        nameWrap.append(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "table-placeholder";
        placeholder.textContent = "H";
        nameWrap.append(placeholder);
      }
      const name = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = product.name;
      const description = document.createElement("small");
      description.textContent = product.description || "Sem descrição";
      name.append(strong, description);
      nameWrap.append(name);
      nameCell.append(nameWrap);
      const category = document.createElement("td");
      category.textContent = product.category || "—";
      const price = document.createElement("td");
      const priceBox = document.createElement("div");
      priceBox.className = "price-edit";
      const priceInput = document.createElement("input");
      priceInput.type = "text";
      priceInput.inputMode = "decimal";
      priceInput.placeholder = "0,00";
      priceInput.setAttribute("aria-label", `Preço de ${product.name}`);
      priceInput.value = product.price === null || product.price === undefined ? "" : Number(product.price).toFixed(2).replace(".", ",");
      const priceSave = document.createElement("button");
      priceSave.type = "button";
      priceSave.textContent = "Salvar";
      priceSave.hidden = true;
      const original = priceInput.value;
      priceInput.addEventListener("input", () => { priceSave.hidden = priceInput.value.trim() === original; });
      priceSave.addEventListener("click", async () => {
        priceSave.disabled = true;
        try {
          const updated = await api(`/api/admin/products/${product.id}/price`, { method: "PATCH", body: JSON.stringify({ price: priceInput.value.trim() }) });
          product.price = updated.price;
          showNotice("Preço atualizado.");
          renderProducts();
        } catch (error) {
          showNotice(error.message, true);
          priceSave.disabled = false;
        }
      });
      priceBox.append(priceInput, priceSave);
      price.append(priceBox);
      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `status-pill${product.active ? "" : " inactive"}`;
      badge.textContent = product.active ? "Ativo" : "Inativo";
      statusCell.append(badge);
      const actionCell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Editar";
      edit.addEventListener("click", () => openProduct(product));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Excluir";
      remove.addEventListener("click", () => removeProduct(product));
      actions.append(edit, remove);
      actionCell.append(actions);
      row.append(nameCell, category, price, statusCell, actionCell);
      table.append(row);
    }
  }

  const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
  const statusLabels = { pending: "Pendente", delivered: "Entregue", cancelled: "Cancelado" };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusPill(status) {
    return el("span", `status-pill status-${status}`, statusLabels[status] || status);
  }

  function summarizeItems(order) {
    return order.items.map((item) => `${item.quantity}× ${item.name}`).join(", ");
  }

  async function changeOrder(order, action) {
    const label = action === "deliver" ? "confirmar a entrega" : "cancelar";
    if (!window.confirm(`Deseja ${label} do pedido ${order.code}?`)) return;
    try {
      await api(`/api/admin/orders/${order.id}/${action}`, { method: "POST", body: "{}" });
      showNotice(action === "deliver" ? "Entrega confirmada." : "Pedido cancelado.");
      byId("order-result").hidden = true;
      loadOrders();
    } catch (error) { showNotice(error.message, true); }
  }

  function orderActions(order) {
    const actions = el("div", "row-actions");
    if (order.status !== "pending") return actions;
    const deliver = el("button", "", "Marcar entregue");
    deliver.type = "button";
    deliver.addEventListener("click", () => changeOrder(order, "deliver"));
    const cancel = el("button", "danger", "Cancelar");
    cancel.type = "button";
    cancel.addEventListener("click", () => changeOrder(order, "cancel"));
    actions.append(deliver, cancel);
    return actions;
  }

  function showOrderResult(order) {
    const box = byId("order-result");
    box.replaceChildren();
    const head = el("div", "order-head");
    head.append(el("strong", "order-code", order.code), statusPill(order.status));
    const list = el("ul", "order-items");
    for (const item of order.items) {
      list.append(el("li", "", `${item.quantity}× ${item.name} — ${money(item.subtotal)}`));
    }
    const meta = [`Feito em ${new Date(order.createdAt).toLocaleString("pt-BR")}`];
    if (order.customerName) meta.push(`Cliente: ${order.customerName}`);
    if (order.deliveredAt) meta.push(`Entregue em ${new Date(order.deliveredAt).toLocaleString("pt-BR")}${order.handledBy ? ` por ${order.handledBy}` : ""}`);
    box.append(head, list, el("p", "order-total", `Total: ${money(order.total)}`), el("p", "order-meta", meta.join(" · ")), orderActions(order));
    box.hidden = false;
  }

  async function loadOrders() {
    try {
      const status = byId("order-filter-status").value;
      const orders = await api(`/api/admin/orders${status ? `?status=${status}` : ""}`);
      const table = byId("orders-table");
      table.replaceChildren();
      byId("orders-empty").hidden = orders.length > 0;
      for (const order of orders) {
        const row = document.createElement("tr");
        const code = el("td");
        code.append(el("strong", "order-code", order.code));
        const statusCell = el("td");
        statusCell.append(statusPill(order.status));
        const actions = el("td");
        actions.append(orderActions(order));
        row.append(code, el("td", "", new Date(order.createdAt).toLocaleString("pt-BR")), el("td", "", summarizeItems(order)), el("td", "", money(order.total)), statusCell, actions);
        table.append(row);
      }
    } catch (error) { showNotice(error.message, true); }
  }

  function renderBars(container, rows, valueKey, format, labelKey) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(el("p", "empty-admin", "Sem dados no período."));
      return;
    }
    const max = Math.max(...rows.map((row) => row[valueKey]), 1);
    for (const row of rows) {
      const line = el("div", "bar-row");
      const track = el("div", "bar-track");
      const fill = el("div", "bar-fill");
      fill.style.width = `${Math.max(4, Math.round(row[valueKey] / max * 100))}%`;
      track.append(fill);
      line.append(el("span", "bar-label", row[labelKey]), track, el("span", "bar-value", format(row[valueKey])));
      container.append(line);
    }
  }

  const MAINTENANCE_LABELS = {
    images: "Imagens órfãs (sem uso)",
    emptyImageFiles: "Imagens corrompidas",
    chunks: "Blocos soltos de upload",
    sessionsExpired: "Sessões expiradas",
    ordersAbandoned: "Pedidos abandonados",
    ordersAnonymous: "Pedidos anônimos antigos",
    legacyAdmins: "Contas antigas sem login",
  };

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
  }

  function renderMaintenanceReport(report) {
    const box = byId("mt-report");
    box.replaceChildren();
    if (!report || report.error) {
      box.append(el("p", "empty-admin", report?.error ? `Falha: ${report.error}` : "Nenhuma limpeza executada nesta sessão."));
      return;
    }
    const head = el("p", "order-meta", report.dryRun
      ? "Simulação: nada foi apagado."
      : `Executado em ${new Date(report.finishedAt).toLocaleString("pt-BR")}`);
    box.append(head);
    const rows = Object.entries(report.removed).filter(([, count]) => count > 0);
    if (!rows.length) {
      box.append(el("p", "empty-admin", "Nada para remover. O banco já está limpo."));
    } else {
      const list = el("ul", "order-items");
      for (const [key, count] of rows) {
        list.append(el("li", "", `${MAINTENANCE_LABELS[key] || key}: ${count}`));
      }
      box.append(list);
    }
    if (report.freedBytes) box.append(el("p", "order-total", `Espaço liberado em imagens: ${formatBytes(report.freedBytes)}`));
    if (report.compaction.redundantIndexes.length) {
      box.append(el("p", "order-meta", `Índices redundantes removidos: ${report.compaction.redundantIndexes.join(", ")}`));
    }
  }

  function applyMaintenanceReport(report) {
    if (!report || !report.finishedAt) return;
    byId("mt-images").textContent = report.imagesKept ?? "—";
    byId("mt-bytes").textContent = formatBytes(report.imageBytesTotal || 0);
    byId("mt-last").textContent = new Date(report.finishedAt).toLocaleTimeString("pt-BR");
    renderMaintenanceReport(report);
  }

  async function loadMaintenance() {
    try {
      const status = await api("/api/admin/maintenance");
      byId("mt-auto").textContent = status.enabled ? `A cada ${status.intervalMinutes} min` : "Desativada";
      applyMaintenanceReport(status.lastRun);
    } catch (error) { showNotice(error.message, true); }
  }

  // Um pedido por vez: o botão fica desabilitado durante a execução, mas um
  // clique duplo rápido dispararia duas limpezas concorrentes sem isso.
  let maintenanceRunning = false;

  async function runMaintenance(dryRun) {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    const progress = byId("maintenance-progress");
    const buttons = [byId("maintenance-run"), byId("maintenance-simulate")];
    for (const button of buttons) button.disabled = true;
    progress.textContent = dryRun ? "Analisando o banco..." : "Limpando o banco...";
    try {
      const report = await api("/api/admin/maintenance/run", {
        method: "POST",
        body: JSON.stringify({ dryRun: String(dryRun), compact: "true" }),
      });
      applyMaintenanceReport(report);
      const removedCount = Object.values(report.removed).reduce((sum, count) => sum + count, 0);
      if (dryRun) {
        showNotice(removedCount
          ? `Simulação: ${removedCount} itens poderiam ser removidos. Nada foi apagado.`
          : "Simulação: o banco já está limpo. Nada a remover.");
      } else {
        showNotice(removedCount ? `Limpeza concluída: ${removedCount} itens removidos.` : "Limpeza concluída: nada a remover.");
      }
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      maintenanceRunning = false;
      for (const button of buttons) button.disabled = false;
      progress.textContent = "";
    }
  }

  byId("maintenance-run").addEventListener("click", () => runMaintenance(false));
  byId("maintenance-simulate").addEventListener("click", () => runMaintenance(true));

  async function loadReports() {
    try {
      const data = await api(`/api/admin/reports?period=${byId("report-period").value}`);
      byId("rep-revenue").textContent = money(data.revenue);
      byId("rep-orders").textContent = data.totalOrders;
      byId("rep-ticket").textContent = money(data.averageTicket);
      byId("rep-pending").textContent = `${data.count.pending} (${money(data.pendingValue)})`;
      const days = data.daily.slice(-14).map((day) => ({ ...day, label: day.date.slice(8, 10) + "/" + day.date.slice(5, 7) }));
      renderBars(byId("rep-daily"), days, "orders", (value) => `${value} ped.`, "label");
      renderBars(byId("rep-top"), data.topProducts, "quantity", (value) => `${value} un.`, "name");
      renderBars(byId("rep-categories"), data.categories, "revenue", money, "name");
    } catch (error) { showNotice(error.message, true); }
  }

  byId("order-lookup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = byId("order-code").value.trim().toUpperCase();
    try {
      showOrderResult(await api(`/api/admin/orders/code/${encodeURIComponent(code)}`));
    } catch (error) {
      byId("order-result").hidden = true;
      showNotice(error.message, true);
    }
  });
  byId("order-filter-status").addEventListener("change", loadOrders);
  byId("report-period").addEventListener("change", loadReports);

  function previewFile(input, image) {
    const file = input.files?.[0];
    const fileName = byId(input.id.replace("-input", "-file-name"));
    if (!file) {
      if (fileName) fileName.textContent = "Nenhuma imagem nova selecionada";
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      input.value = "";
      if (fileName) fileName.textContent = "Nenhuma imagem nova selecionada";
      showNotice("Escolha uma imagem PNG, JPG ou WebP de até 5 MB.", true);
      return;
    }
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    image.dataset.objectUrl = URL.createObjectURL(file);
    image.src = image.dataset.objectUrl;
    image.hidden = false;
    if (fileName) fileName.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    syncPreviewPlaceholder(image);
  }

  function syncPreviewPlaceholder(image) {
    const placeholder = image.parentElement?.querySelector(".preview-placeholder");
    if (placeholder) placeholder.hidden = !image.hidden;
  }

  function syncPersistedPreview(image) {
    image.hidden = !image.dataset.savedSrc;
    image.src = image.dataset.savedSrc || "";
    syncPreviewPlaceholder(image);
  }

  function updateLiveText(formElement) {
    for (const previewText of document.querySelectorAll("[data-preview-text]")) {
      const field = formElement.elements[previewText.dataset.previewText];
      if (field) previewText.textContent = field.value.trim() || field.placeholder || "Adicione um texto para pré-visualizar.";
    }
  }

  function updateProductPreview() {
    const category = byId("product-category-select").selectedOptions[0];
    const name = form.elements.name.value.trim();
    const description = form.elements.description.value.trim();
    const price = form.elements.price.value.trim();
    byId("product-preview-category").textContent = category?.textContent || "Categoria";
    document.querySelector('[data-product-preview="name"]').textContent = name || "Nome do produto";
    document.querySelector('[data-product-preview="description"]').textContent = description || "A descrição aparecerá aqui";
    document.querySelector('[data-product-preview="price"]').textContent = price ? `R$ ${price}` : "Consulte o preço";
  }

  async function openProduct(product = null) {
    if (!state.categories.length) {
      try {
        state.categories = await api("/api/admin/categories");
      } catch (error) {
        showNotice(error.message, true);
        return;
      }
    }
    if (!state.categories.length) {
      showNotice("Crie pelo menos uma categoria antes de cadastrar produtos.", true);
      activateView("categories");
      return;
    }
    form.reset();
    form.elements.id.value = product?.id || "";
    byId("product-dialog-title").textContent = product ? "Editar produto" : "Novo produto";
    form.elements.name.value = product?.name || "";
    form.elements.description.value = product?.description || "";
    form.elements.price.value = product?.price ?? "";
    form.elements.active.checked = product?.active ?? true;
    form.elements.featured.checked = product?.featured ?? false;
    form.elements.promotion.checked = product?.promotion ?? false;
    form.elements.new.checked = product?.new ?? false;
    fillCategorySelect(byId("product-category-select"), product?.categoryId || "");
    const preview = byId("product-image-preview");
    preview.hidden = !product?.imageUrl;
    preview.src = product?.imageUrl || "";
    preview.dataset.savedSrc = product?.imageUrl || "";
    preview.dataset.objectUrl = "";
    syncPreviewPlaceholder(preview);
    byId("product-image-file-name").textContent = "Nenhuma imagem nova selecionada";
    byId("remove-product-image-wrap").hidden = !product?.imageUrl;
    form.elements.removeImage.checked = false;
    byId("product-progress").textContent = "";
    gallery.existing = product?.gallery || [];
    gallery.removed = new Set();
    gallery.added = [];
    renderGallery();
    updateProductPreview();
    dialog.showModal();
  }

  const MAX_GALLERY = 5;
  const gallery = { existing: [], removed: new Set(), added: [] };

  function renderGallery() {
    const grid = byId("gallery-grid");
    grid.replaceChildren();
    const addThumb = (src, label, onRemove) => {
      const item = document.createElement("div");
      item.className = "gallery-thumb";
      const img = document.createElement("img");
      img.src = src;
      img.alt = label;
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", "Remover foto");
      button.textContent = "×";
      button.addEventListener("click", onRemove);
      item.append(img, button);
      grid.append(item);
    };
    for (const image of gallery.existing.filter((item) => !gallery.removed.has(item.id))) {
      addThumb(image.url, "Foto extra salva", () => { gallery.removed.add(image.id); renderGallery(); });
    }
    gallery.added.forEach((entry, index) => addThumb(entry.url, "Nova foto extra", () => {
      URL.revokeObjectURL(entry.url);
      gallery.added.splice(index, 1);
      renderGallery();
    }));
    const total = gallery.existing.length - gallery.removed.size + gallery.added.length;
    byId("gallery-count").textContent = `(${total}/${MAX_GALLERY})`;
    byId("product-gallery-input").disabled = total >= MAX_GALLERY;
  }

  async function removeProduct(product) {
    if (!window.confirm(`Excluir "${product.name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await api(`/api/admin/products/${product.id}`, { method: "DELETE" });
      showNotice("Produto excluído.");
      await loadProducts();
    } catch (error) { showNotice(error.message, true); }
  }

  function previewImageFromId(inputId, previewId) {
    byId(inputId).addEventListener("change", () => previewFile(byId(inputId), byId(previewId)));
  }

  async function loadSettings() {
    try {
      const settings = await api("/api/admin/settings");
      state.settings = settings;
      const settingsForm = byId("settings-form");
      settingsForm.elements.removeHeroImage.checked = false;
      settingsForm.elements.removeAboutImage.checked = false;
      for (const [key, value] of Object.entries(settings)) {
        if (settingsForm.elements[key] && typeof value === "string") settingsForm.elements[key].value = value;
      }
      setPersistedPreview("hero-image-preview", settings.heroImageId);
      setPersistedPreview("about-image-preview", settings.aboutImageId);
      updateLiveText(settingsForm);
    } catch (error) { showNotice(error.message, true); }
  }

  function setPersistedPreview(id, imageId) {
    const preview = byId(id);
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.dataset.objectUrl = "";
    preview.src = imageId ? `/api/images/${imageId}` : "";
    preview.dataset.savedSrc = preview.src;
    preview.hidden = !imageId;
    syncPreviewPlaceholder(preview);
  }

  byId("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("login-submit");
    const error = byId("login-error");
    button.disabled = true;
    button.textContent = "Verificando...";
    error.textContent = "";
    try {
      const response = await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: byId("login-username").value, password: byId("login-password").value }),
      });
      state.csrf = response.csrfToken;
      showAdmin();
      activateView("dashboard");
    } catch (exception) {
      error.textContent = exception.message;
    } finally {
      button.disabled = false;
      button.textContent = "Entrar no painel";
    }
  });
  byId("toggle-password").addEventListener("click", (event) => {
    const input = byId("login-password");
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    event.currentTarget.textContent = showing ? "Ocultar" : "Mostrar";
    event.currentTarget.setAttribute("aria-label", showing ? "Ocultar senha" : "Mostrar senha");
  });
  byId("logout-button").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      showLogin();
      await csrfToken();
    } catch (error) { showNotice(error.message, true); }
  });
  byId("new-product-button").addEventListener("click", () => openProduct());
  byId("product-dialog-close").addEventListener("click", () => dialog.close());
  byId("product-cancel").addEventListener("click", () => dialog.close());
  byId("product-image-input").addEventListener("change", () => previewFile(byId("product-image-input"), byId("product-image-preview")));
  byId("product-image-input").addEventListener("change", () => {
    if (byId("product-image-input").files[0]) form.elements.removeImage.checked = false;
  });
  form.elements.removeImage.addEventListener("change", () => {
    const preview = byId("product-image-preview");
    if (form.elements.removeImage.checked && !byId("product-image-input").files[0]) {
      preview.hidden = true;
    } else if (form.elements.removeImage.checked && byId("product-image-input").files[0]) {
      preview.hidden = false;
    } else if (!byId("product-image-input").files[0]) {
      syncPersistedPreview(preview);
    }
    syncPreviewPlaceholder(preview);
  });
  dialog.addEventListener("close", () => {
    const preview = byId("product-image-preview");
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.dataset.objectUrl = "";
  });
  for (const field of ["name", "description", "price"]) form.elements[field].addEventListener("input", updateProductPreview);
  byId("product-category-select").addEventListener("change", updateProductPreview);
  byId("product-gallery-input").addEventListener("change", (event) => {
    const room = MAX_GALLERY - (gallery.existing.length - gallery.removed.size + gallery.added.length);
    const files = [...event.target.files].slice(0, Math.max(room, 0));
    if (event.target.files.length > files.length) showNotice(`Cada produto aceita até ${MAX_GALLERY} fotos extras.`, true);
    for (const file of files) gallery.added.push({ file, url: URL.createObjectURL(file) });
    event.target.value = "";
    renderGallery();
  });
  byId("product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const progress = byId("product-progress");
    const submit = form.querySelector('[type="submit"]');
    const id = form.elements.id.value;
    const data = new FormData();
    for (const field of ["name", "description", "categoryId", "price"]) data.append(field, form.elements[field].value);
    for (const field of ["active", "featured", "promotion", "new"]) data.append(field, String(form.elements[field].checked));
    data.append("removeImage", String(form.elements.removeImage.checked));
    if (byId("product-image-input").files[0]) data.append("image", byId("product-image-input").files[0]);
    data.append("removeGallery", [...gallery.removed].join(","));
    for (const entry of gallery.added) data.append("gallery", entry.file);
    submit.disabled = true;
    progress.textContent = "Salvando produto...";
    try {
      await uploadRequest(id ? `/api/admin/products/${id}` : "/api/admin/products", data, progress);
      form.reset();
      dialog.close();
      showNotice(id ? "Produto atualizado." : "Produto cadastrado.");
      await loadProducts();
    } catch (error) { progress.textContent = ""; showNotice(error.message, true); }
    finally { submit.disabled = false; }
  });

  byId("category-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = byId("category-id").value;
    const body = JSON.stringify({ name: byId("category-name").value, order: Number(byId("category-order").value) });
    try {
      await api(id ? `/api/admin/categories/${id}` : "/api/admin/categories", { method: id ? "PUT" : "POST", body });
      resetCategoryForm();
      showNotice(id ? "Categoria atualizada." : "Categoria adicionada.");
      await loadCategories();
    } catch (error) { showNotice(error.message, true); }
  });
  function resetCategoryForm() {
    byId("category-form").reset();
    byId("category-id").value = "";
    byId("category-order").value = "0";
    byId("category-save").textContent = "Adicionar categoria";
    byId("category-cancel").hidden = true;
  }
  byId("category-cancel").addEventListener("click", resetCategoryForm);
  byId("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const settingsForm = byId("settings-form");
    const data = new FormData();
    for (const field of ["topbar", "heroTitle", "heroText", "aboutTitle", "aboutText", "whatsapp", "phone", "address", "hours", "mapUrl", "instagram", "facebook"]) {
      data.append(field, settingsForm.elements[field].value);
    }
    data.append("removeHeroImage", String(settingsForm.elements.removeHeroImage.checked));
    data.append("removeAboutImage", String(settingsForm.elements.removeAboutImage.checked));
    for (const name of ["heroImage", "aboutImage"]) {
      const file = settingsForm.elements[name].files[0];
      if (file) data.append(name, file);
    }
    const button = settingsForm.querySelector('[type="submit"]');
    button.disabled = true;
    byId("settings-progress").textContent = "Salvando conteúdo...";
    try {
      const saved = await uploadRequest("/api/admin/settings", data, byId("settings-progress"));
      state.settings = saved;
      setPersistedPreview("hero-image-preview", saved.heroImageId);
      setPersistedPreview("about-image-preview", saved.aboutImageId);
      settingsForm.elements.heroImage.value = "";
      settingsForm.elements.aboutImage.value = "";
      byId("hero-image-file-name").textContent = "Nenhuma imagem nova selecionada";
      byId("about-image-file-name").textContent = "Nenhuma imagem nova selecionada";
      showNotice("Conteúdo salvo e publicado no site.");
    } catch (error) {
      byId("settings-progress").textContent = "";
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
      byId("settings-progress").textContent = "";
    }
  });

  byId("product-filter-search").addEventListener("input", renderProducts);
  byId("product-filter-category").addEventListener("change", renderProducts);
  byId("product-filter-active").addEventListener("change", renderProducts);
  for (const button of document.querySelectorAll(".nav-item")) button.addEventListener("click", () => activateView(button.dataset.view));
  for (const button of document.querySelectorAll("[data-go]")) button.addEventListener("click", () => {
    activateView(button.dataset.go);
    if (button.dataset.action === "new-product") openProduct();
  });
  byId("mobile-menu").addEventListener("click", (event) => {
    const open = byId("sidebar").classList.toggle("open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
  });
  previewImageFromId("hero-image-input", "hero-image-preview");
  previewImageFromId("about-image-input", "about-image-preview");
  byId("hero-image-input").addEventListener("change", () => {
    if (byId("hero-image-input").files[0]) byId("settings-form").elements.removeHeroImage.checked = false;
    if (!byId("hero-image-input").files[0]) syncPersistedPreview(byId("hero-image-preview"));
  });
  byId("about-image-input").addEventListener("change", () => {
    if (byId("about-image-input").files[0]) byId("settings-form").elements.removeAboutImage.checked = false;
    if (!byId("about-image-input").files[0]) syncPersistedPreview(byId("about-image-preview"));
  });
  for (const [name, previewId] of [["removeHeroImage", "hero-image-preview"], ["removeAboutImage", "about-image-preview"]]) {
    byId("settings-form").elements[name].addEventListener("change", (event) => {
      const preview = byId(previewId);
      const fileInput = byId(name === "removeHeroImage" ? "hero-image-input" : "about-image-input");
      if (event.currentTarget.checked && !fileInput.files[0]) preview.hidden = true;
      else if (event.currentTarget.checked) preview.hidden = false;
      else if (!fileInput.files[0]) {
        syncPersistedPreview(preview);
      }
      syncPreviewPlaceholder(preview);
    });
  }
  for (const field of ["heroTitle", "heroText", "aboutTitle", "aboutText"]) {
    byId("settings-form").elements[field].addEventListener("input", () => updateLiveText(byId("settings-form")));
  }

  async function initialize() {
    try {
      await csrfToken();
      updateLiveText(byId("settings-form"));
      const response = await fetch("/api/admin/session", { credentials: "same-origin" });
      const session = await response.json();
      if (session.authenticated) {
        showAdmin();
        activateView("dashboard");
      } else showLogin();
    } catch (error) {
      showLogin();
      byId("login-error").textContent = "Não foi possível conectar ao painel. Verifique a configuração do servidor.";
      console.error("Falha ao iniciar painel:", error);
    }
  }
  initialize();
})();
