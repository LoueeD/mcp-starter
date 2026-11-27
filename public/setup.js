(() => {
  const $ = (id) => document.getElementById(id);

  // Keep native masking unless the browser and loaded stylesheet provide visual masking.
  for (const id of ["api-key", "replacement-key"]) {
    const input = $(id);
    if (
      window.CSS?.supports("-webkit-text-security", "disc") &&
      getComputedStyle(input).getPropertyValue("-webkit-text-security") === "disc"
    )
      input.type = "text";
  }

  function renderAuthMode() {
    const signup = location.pathname === "/signup";
    $("auth-switch").dataset.mode = signup ? "signup" : "login";
    $("signup-panel").hidden = !signup;
    $("signup-hint").hidden = !signup;
    $("login-panel").hidden = signup;
    for (const [id, active] of [
      ["login-link", !signup],
      ["signup-link", signup],
    ]) {
      if (active) $(id).setAttribute("aria-current", "page");
      else $(id).removeAttribute("aria-current");
    }
  }

  for (const id of ["login-link", "signup-link"])
    $(id).addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      if (busy) return;
      history.pushState(null, "", $(id).getAttribute("href"));
      $("status").hidden = true;
      renderAuthMode();
    });

  window.addEventListener("popstate", renderAuthMode);
  renderAuthMode();

  let session = null;
  let connections = [];
  let passkeys = [];
  let cursor = null;
  let busy = false;
  let pendingAction = null;
  let activePasskey = null;
  let needsReview = false;
  let accessConfig = null;

  const messages = {
    AUTH_FAILED: "Your session or passkey could not be verified. Sign in again.",
    CSRF: "Refresh your session before trying this action again.",
    CONNECTION_CHANGED:
      "This connection changed. The list has been refreshed; review it before trying again.",
    CONNECTION_NOT_FOUND: "This connection is no longer available.",
    INVALID_CREDENTIAL:
      "The app credential was rejected. For the demo, use demo_local_development.",
    CONNECTION_LIMIT:
      "You have reached the limit of 20 active connections. Revoke one before creating another.",
    PASSKEY_LIMIT: "This account has reached its passkey limit.",
    PASSKEY_EXISTS: "This passkey is already registered. Choose another key or device.",
    LAST_PASSKEY: "Add another independently usable passkey before removing your last one.",
    RATE_LIMITED: "Too many requests. Wait a minute before trying again.",
    INVALID_ARGUMENTS: "Check the form details and try again.",
    INVALID_CURSOR: "The list could not continue. Refresh it.",
    INVALID_ACCESS: "Check the access selections and try again.",
    REQUEST_TOO_LARGE: "This request is too large. Check the credential you pasted.",
    SERVICE_UNAVAILABLE: "The service is temporarily unavailable.",
    STORAGE_UNAVAILABLE: "Account storage is temporarily unavailable.",
    AUTH_CAPACITY: "Wait a moment before starting a new passkey ceremony.",
  };

  class RequestError extends Error {
    constructor(code, uncertain = false) {
      super(messages[code] || "The request could not be completed.");
      this.code = code;
      this.uncertain = uncertain;
    }
  }

  let noticeTimer;
  function notice(message, error = false) {
    clearTimeout(noticeTimer);
    const status = $("status");
    status.textContent = message;
    status.className = `status${error ? " error" : ""}`;
    status.hidden = false;
    noticeTimer = setTimeout(
      () => {
        status.hidden = true;
        status.textContent = "";
      },
      error ? 8000 : 5000,
    );
  }

  function show(id) {
    $("sign-out").hidden = !["workspace", "access-page"].includes(id);
    for (const state of ["checking", "unavailable", "signed-out", "workspace", "access-page"])
      $(state).hidden = state !== id;
  }

  function clearReveal() {
    $("install-url").value = "";
    $("reveal").hidden = true;
  }

  function clearKeys() {
    $("api-key").value = "";
    $("replacement-key").value = "";
  }

  function signedOut() {
    $("connection-dialog").close();
    accessConfig = null;
    $("access-resources").replaceChildren();
    session = null;
    connections = [];
    passkeys = [];
    cursor = null;
    needsReview = false;
    clearReveal();
    clearKeys();
    $("connection-list").replaceChildren();
    $("passkey-list").replaceChildren();
    show("signed-out");
  }

  function setBusy(value) {
    busy = value;
    $("main").setAttribute("aria-busy", String(value));
    for (const element of document.querySelectorAll("button,input"))
      element.disabled =
        element.id === "cancel-passkey"
          ? !activePasskey
          : value || element.dataset.blocked === "true";
    $("create-connection").disabled = value || needsReview;
    $("create-connection-submit").disabled = value || needsReview;
  }

  async function request(path, { method = "GET", body, mutation = false } = {}) {
    let response;
    let data;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(mutation ? { "X-CSRF-Token": session?.csrf_token || "" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      data = await response.json();
    } catch {
      throw new RequestError("INTERRUPTED", method !== "GET");
    }
    if (!response.ok)
      throw new RequestError(
        data.error?.code || "SERVICE_UNAVAILABLE",
        method !== "GET" && response.status >= 500,
      );
    return data;
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  const date = (timestamp) =>
    timestamp
      ? new Date(timestamp).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "Never";

  function actionButton(text, action, row, blocked = false) {
    const button = node("button", text, action === "revoke" || action === "remove" ? "danger" : "");
    button.type = "button";
    button.dataset.blocked = String(blocked);
    button.disabled = busy || blocked;
    button.setAttribute("aria-label", `${text}: ${row.name || row.label}`);
    button.addEventListener("click", () => {
      if (busy || blocked) return;
      button.closest("[popover]")?.hidePopover();
      if (action === "access") location.href = `/connections/${encodeURIComponent(row.id)}/access`;
      else openAction(action, row);
    });
    return button;
  }

  function render() {
    $("workspace-title").textContent = `Hello ${session.account.label}, here are your connections.`;
    $("recovery-banner").hidden = passkeys.length !== 1;
    $("add-passkey").hidden = passkeys.length === 1;
    $("review-create").hidden = !needsReview;
    $("create-connection").disabled = busy || needsReview;

    const list = $("connection-list");
    list.replaceChildren();
    $("connections-section").hidden = connections.length === 0;
    for (const connection of connections) {
      const row = node("article", undefined, "row");
      const heading = node("div", undefined, "row-info");
      heading.append(
        node("h3", connection.name),
        node(
          "span",
          connection.status === "revoked" ? "Revoked" : connection.disabled ? "Disabled" : "Active",
          connection.status === "active" && !connection.disabled ? "state good" : "state",
        ),
      );
      row.append(heading);
      row.append(
        node(
          "p",
          `Created ${date(connection.created_at)} · Last rotated ${date(connection.rotated_at)}`,
          "row-meta",
        ),
      );
      if (connection.status === "active") {
        const actions = node("div", undefined, "row-actions");
        const trigger = node("button", "⋯", "connection-menu-trigger");
        trigger.type = "button";
        trigger.setAttribute("aria-label", `Connection actions: ${connection.name}`);
        const menu = node("div", undefined, "connection-menu");
        menu.id = `connection-menu-${connection.id}`;
        menu.setAttribute("popover", "auto");
        menu.setAttribute("role", "group");
        menu.setAttribute("aria-label", `Actions for ${connection.name}`);
        trigger.setAttribute("popovertarget", menu.id);
        trigger.setAttribute("aria-controls", menu.id);
        trigger.setAttribute("aria-expanded", "false");
        menu.addEventListener("beforetoggle", (event) => {
          trigger.setAttribute("aria-expanded", String(event.newState === "open"));
          if (event.newState === "open") {
            const rect = trigger.getBoundingClientRect();
            menu.style.left = `${Math.max(8, Math.min(rect.right - 180, innerWidth - 188))}px`;
            menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 320))}px`;
          }
        });
        for (const [text, action] of [
          ["Control access", "access"],
          ["Rename", "rename"],
          ["Rotate URL", "rotate"],
          ["Replace credential", "replace"],
          [connection.disabled ? "Enable" : "Disable", connection.disabled ? "enable" : "disable"],
          ["Revoke", "revoke"],
        ])
          menu.append(actionButton(text, action, connection));
        actions.append(trigger, menu);
        row.append(actions);
      }
      list.append(row);
    }
    $("more-connections").hidden = !cursor;

    const keys = $("passkey-list");
    keys.replaceChildren();
    for (const key of passkeys) {
      const row = node("article", undefined, "row");
      row.append(
        node("h3", key.label),
        node(
          "p",
          `Added ${date(key.created_at)} · Last used ${date(key.last_used_at)}`,
          "row-meta",
        ),
      );
      if (passkeys.length > 1) row.append(actionButton("Remove passkey", "remove", key));
      keys.append(row);
    }
  }

  async function refresh() {
    const current = await request("/api/auth/session");
    if (!current.authenticated) {
      signedOut();
      return;
    }
    if (session && session.account.id !== current.account.id) {
      clearReveal();
      clearKeys();
    }
    session = current;
    const [page, keys] = await Promise.all([request("/api/connections"), request("/api/passkeys")]);
    connections = page.connections;
    cursor = page.next_cursor;
    passkeys = keys.passkeys;
    show("workspace");
    render();
    if (accessId) await loadAccess();
  }

  async function recover(error, message) {
    if (error.name === "TimeoutError") {
      notice(
        "The browser did not complete the passkey request. Try again, or use another browser if no prompt appeared.",
        true,
      );
      return;
    }
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      notice("The passkey request was cancelled or timed out. You can start a new request.");
      return;
    }
    if (error.name === "InvalidStateError") {
      notice("This passkey is already registered. Choose another key or device.", true);
      return;
    }
    if (error.name === "SecurityError") {
      notice(
        "Passkeys require the configured secure website address. Check the address and try again.",
        true,
      );
      return;
    }
    notice(
      error instanceof RequestError && error.uncertain
        ? message ||
            "The response was interrupted. Refresh and review the current state before trying another change."
        : error instanceof RequestError
          ? error.message
          : "The request could not be completed. Refresh and try again.",
      true,
    );
    try {
      await refresh();
    } catch {
      notice(
        "The current state could not be refreshed. Check again before trying another change.",
        true,
      );
    }
  }

  async function run(work) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      await recover(error);
    } finally {
      setBusy(false);
    }
  }

  function bytes(value) {
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  }

  function encoded(value) {
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  }

  function creationOptions(options) {
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function")
      return PublicKeyCredential.parseCreationOptionsFromJSON(options);
    return {
      ...options,
      challenge: bytes(options.challenge),
      user: { ...options.user, id: bytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({
        ...item,
        id: bytes(item.id),
      })),
    };
  }

  function authenticationOptions(options) {
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function")
      return PublicKeyCredential.parseRequestOptionsFromJSON(options);
    return {
      ...options,
      challenge: bytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((item) => ({
        ...item,
        id: bytes(item.id),
      })),
    };
  }

  function credentialJSON(credential) {
    if (!credential) throw new DOMException("Cancelled", "NotAllowedError");
    if (typeof credential.toJSON === "function") return credential.toJSON();
    const response = credential.response;
    return {
      id: credential.id,
      rawId: encoded(credential.rawId),
      type: credential.type,
      ...(credential.authenticatorAttachment
        ? { authenticatorAttachment: credential.authenticatorAttachment }
        : {}),
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encoded(response.clientDataJSON),
        ...(response.attestationObject
          ? {
              attestationObject: encoded(response.attestationObject),
              transports: response.getTransports?.() || [],
            }
          : {
              authenticatorData: encoded(response.authenticatorData),
              signature: encoded(response.signature),
              ...(response.userHandle ? { userHandle: encoded(response.userHandle) } : {}),
            }),
      },
    };
  }

  async function choosePasskey(kind, options) {
    const controller = new AbortController();
    activePasskey = controller;
    $("passkey-progress").hidden = false;
    $("cancel-passkey").disabled = false;
    let timer;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
      timer = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "The browser did not complete the passkey request. Try again, or use another browser if no prompt appeared.",
              "TimeoutError",
            ),
          ),
        90_000,
      );
    });
    try {
      const publicKey =
        kind === "login" ? authenticationOptions(options) : creationOptions(options);
      publicKey.timeout = 90_000;
      const credential =
        kind === "login"
          ? navigator.credentials.get({
              publicKey,
              mediation: "required",
              signal: controller.signal,
            })
          : navigator.credentials.create({ publicKey, signal: controller.signal });
      return await Promise.race([credential, cancelled]);
    } finally {
      clearTimeout(timer);
      activePasskey = null;
      $("passkey-progress").hidden = true;
      $("cancel-passkey").disabled = true;
    }
  }

  $("cancel-passkey").addEventListener("click", () => activePasskey?.abort());

  async function passkey(kind, label) {
    notice(
      kind === "login"
        ? "Choose your passkey to sign in."
        : "Choose a key or device to create your passkey.",
    );
    const base = kind === "add" ? "/api/passkeys" : `/api/auth/${kind}`;
    const options = await request(`${base}/options`, {
      method: "POST",
      body: kind === "login" ? {} : { label },
      mutation: kind === "add",
    });
    const credential = await choosePasskey(kind, options);
    await request(`${base}/verify`, {
      method: "POST",
      body: { response: credentialJSON(credential) },
      mutation: kind === "add",
    });
    await refresh();
    notice(
      kind === "add"
        ? "Passkey added. Keep your independent recovery key accessible."
        : "You’re signed in.",
    );
    $("workspace-title").focus();
  }

  function reveal(data) {
    const url = new URL(data.install_url);
    if (
      url.origin !== location.origin ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^\/mcp\/[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(url.pathname)
    )
      throw new RequestError("INTERRUPTED", true);
    $("install-url").value = url.href;
    $("reveal").hidden = false;
    $("reveal-title").focus();
    $("reveal").scrollIntoView({ block: "nearest" });
  }

  function openAction(action, row) {
    pendingAction = { action, row };
    $("action-form").reset();
    $("dialog-error").hidden = true;
    $("dialog-name-field").hidden = !["rename", "add"].includes(action);
    $("dialog-key-field").hidden = action !== "replace";
    $("dialog-name").required = ["rename", "add"].includes(action);
    $("dialog-name").maxLength = action === "add" ? 50 : 100;
    $("replacement-key").required = action === "replace";
    $("dialog-name").value = action === "rename" ? row.name : "";
    const copy = {
      rename: ["Rename connection", "Update the name shown in your connection list.", "Save name"],
      add: [
        "Add a passkey",
        "Choose another independently usable key or device. Give it a name you will recognise.",
        "Create passkey",
      ],
      rotate: [
        "Rotate connection URL",
        `The current URL for “${row.name}” will stop working. Copy the new URL and update your MCP client after rotating.`,
        "Rotate URL",
      ],
      revoke: [
        "Revoke connection",
        `“${row.name}” will stop working. This cannot be undone; you can create a new connection later.`,
        "Revoke connection",
      ],
      replace: [
        "Replace app credential",
        "The URL stays the same. The new credential is encrypted at rest and used for future upstream calls.",
        "Replace credential",
      ],
      remove: [
        "Remove passkey",
        `Remove “${row.label}”? All sessions will be signed out. Sign in again with a remaining passkey.`,
        "Remove passkey",
      ],
    }[action];
    $("dialog-title").textContent = copy[0];
    $("dialog-copy").textContent = copy[1];
    $("dialog-submit").textContent = copy[2];
    $("dialog-submit").className = ["revoke", "remove"].includes(action) ? "danger" : "primary";
    $("action-dialog").showModal();
    $("dialog-title").focus();
  }

  const accessId = /^\/connections\/([0-9a-f-]{36})\/access$/.exec(location.pathname)?.[1];

  async function loadAccess() {
    show("access-page");
    $("access-error").hidden = true;
    try {
      accessConfig = await request(`/api/connections/${accessId}/access`);
      renderAccess();
    } catch (error) {
      accessConfig = null;
      $("access-resources").replaceChildren();
      $("access-error").hidden = false;
      $("access-error").textContent = error.message;
      $("access-save").dataset.blocked = "true";
      $("access-save").disabled = true;
      throw error;
    }
  }

  function renderAccess() {
    $("access-name").textContent = accessConfig.connection.name;
    $("access-state").textContent = accessConfig.connection.disabled
      ? "Connection disabled. Access changes can be saved but requests stay blocked until it is enabled."
      : "Saving updates the connection revision. Existing MCP clients must rediscover before their next operation.";
    $("access-save").dataset.blocked = "false";
    $("access-save").disabled = busy;
    const container = $("access-resources");
    container.replaceChildren();
    for (const resource of accessConfig.resources) {
      const grant = accessConfig.policy.resources[resource.name] || {
        read: false,
        create: false,
        update: false,
        delete: false,
      };
      accessConfig.policy.resources[resource.name] = grant;
      const section = node("fieldset", undefined, "access-table");
      section.append(node("legend", resource.label));
      section.append(node("p", resource.description, "hint"));
      const options = node("div", undefined, "access-options");
      const inputs = {};
      function sync() {
        for (const kind of ["read", "create", "update", "delete"]) {
          const input = inputs[kind];
          if (!input) continue;
          const blocked = kind !== "read" && !grant.read;
          input.dataset.blocked = String(blocked);
          input.disabled = busy || blocked;
          input.checked = grant[kind] && grant.read;
        }
      }
      for (const [kind, label] of [
        ["read", "Read (list/get)"],
        ["create", "Create"],
        ["update", "Update"],
        ["delete", "Delete"],
      ]) {
        const control = node("label", undefined, "check");
        const input = node("input");
        input.type = "checkbox";
        inputs[kind] = input;
        input.setAttribute("aria-label", `${label}: ${resource.label}`);
        input.addEventListener("change", () => {
          grant[kind] = input.checked;
          if (kind === "read" && !input.checked)
            for (const write of ["create", "update", "delete"]) grant[write] = false;
          sync();
        });
        control.append(input, node("span", label));
        options.append(control);
      }
      section.append(options);
      container.append(section);
      sync();
    }
  }

  $("access-refresh").addEventListener("click", () => run(loadAccess));
  $("access-readonly").addEventListener("click", () => {
    if (busy || !accessConfig) return;
    for (const grant of Object.values(accessConfig.policy.resources)) {
      grant.create = false;
      grant.update = false;
      grant.delete = false;
    }
    renderAccess();
  });

  $("access-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !accessConfig) return;
    run(async () => {
      try {
        await request(`/api/connections/${accessId}/access`, {
          method: "PUT",
          mutation: true,
          body: {
            revision: accessConfig.connection.revision,
            policy: accessConfig.policy,
          },
        });
        await loadAccess();
        notice("Access saved. Rediscover in your MCP client to use the updated permissions.");
      } catch (error) {
        $("access-error").hidden = false;
        $("access-error").textContent =
          "Access was not confirmed. Refresh and review the saved settings before trying again.";
        throw error;
      }
    });
  });

  $("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.currentTarget.reportValidity())
      run(() => passkey("register", $("account-label").value.trim()));
  });
  $("sign-in").addEventListener("click", () => run(() => passkey("login")));

  $("sign-out").addEventListener("click", () =>
    run(async () => {
      clearReveal();
      clearKeys();
      await request("/api/auth/session", { method: "DELETE", mutation: true });
      signedOut();
      notice("You’re signed out.");
      $("welcome-title").focus();
    }),
  );

  $("refresh").addEventListener("click", () =>
    run(async () => {
      await refresh();
      notice("Connection list refreshed.");
    }),
  );

  $("more-connections").addEventListener("click", () =>
    run(async () => {
      if (!cursor) return;
      const page = await request("/api/connections?cursor=" + encodeURIComponent(cursor));
      const seen = new Set(connections.map((item) => item.id));
      connections.push(...page.connections.filter((item) => !seen.has(item.id)));
      cursor = page.next_cursor;
      render();
    }),
  );

  $("add-passkey").addEventListener("click", () => {
    if (!busy) openAction("add", {});
  });
  $("recovery-add").addEventListener("click", () => {
    if (!busy) openAction("add", {});
  });

  $("create-connection").addEventListener("click", () => {
    if (busy || needsReview || !session) return;
    $("connection-form").reset();
    $("connection-name").value = "My connection";
    $("connection-dialog").showModal();
    $("connection-dialog-title").focus();
  });
  $("connection-cancel").addEventListener("click", () => {
    if (!busy) $("connection-dialog").close();
  });
  $("connection-dialog").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  $("connection-dialog").addEventListener("close", () => {
    $("connection-form").reset();
  });

  $("connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || needsReview || !event.currentTarget.reportValidity()) return;
    run(async () => {
      notice("Checking the credential and creating the connection…");
      try {
        const data = await request("/api/connections", {
          method: "POST",
          mutation: true,
          body: {
            name: $("connection-name").value.trim() || "My connection",
            credential: $("api-key").value,
          },
        });
        $("connection-dialog").close();
        reveal(data);
        await refresh();
        notice("Connection created. Copy the URL before leaving.");
      } catch (error) {
        $("connection-dialog").close();
        if (error.uncertain) {
          needsReview = true;
          $("review-create").hidden = false;
        }
        await recover(
          error,
          "The create response was interrupted. Review the list: if the connection exists, rotate it to obtain a new URL. Do not repeat creation without checking.",
        );
      } finally {
        $("api-key").value = "";
      }
    });
  });

  $("review-create").addEventListener("click", () =>
    run(async () => {
      await refresh();
      needsReview = false;
      render();
      notice(
        "List refreshed. Rotate an existing connection to get its URL, or create another if you need one.",
      );
      $("connections-title").focus();
    }),
  );

  $("action-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !pendingAction || !event.currentTarget.reportValidity()) return;
    run(async () => {
      const { action, row } = pendingAction;
      try {
        if (action === "add") {
          const label = $("dialog-name").value.trim();
          $("action-dialog").close();
          await passkey("add", label);
          return;
        }
        if (action === "remove") {
          await request("/api/passkeys/" + encodeURIComponent(row.id), {
            method: "DELETE",
            mutation: true,
          });
          $("action-dialog").close();
          signedOut();
          notice("Passkey removed. Sign in with a remaining passkey.");
          $("welcome-title").focus();
          return;
        }
        const path = "/api/connections/" + encodeURIComponent(row.id);
        const method =
          action === "rotate"
            ? "POST"
            : action === "revoke"
              ? "DELETE"
              : action === "disable" || action === "enable"
                ? "POST"
                : "PATCH";
        const body = {
          revision: row.revision,
          ...(action === "rename" ? { name: $("dialog-name").value.trim() } : {}),
          ...(action === "replace" ? { credential: $("replacement-key").value } : {}),
        };
        const data = await request(
          path +
            (action === "rotate" || action === "disable" || action === "enable"
              ? `/${action}`
              : ""),
          { method, body, mutation: true },
        );
        $("action-dialog").close();
        if (action === "rotate") reveal(data);
        else if (action === "revoke") clearReveal();
        await refresh();
        notice(
          action === "rotate"
            ? "URL rotated. Copy the new URL and update your MCP client."
            : action === "replace"
              ? "App credential replaced."
              : action === "rename"
                ? "Connection renamed."
                : action === "disable"
                  ? "Connection disabled. Requests already running may still finish."
                  : action === "enable"
                    ? "Connection enabled."
                    : "Connection revoked.",
        );
      } catch (error) {
        $("action-dialog").close();
        await recover(
          error,
          "The response was interrupted. Review the refreshed list before making another change. If a URL was rotated, rotate again deliberately to obtain a new one.",
        );
      } finally {
        $("replacement-key").value = "";
      }
    });
  });

  $("dialog-cancel").addEventListener("click", () => {
    if (!busy) $("action-dialog").close();
  });
  $("action-dialog").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  $("action-dialog").addEventListener("close", () => {
    $("replacement-key").value = "";
    pendingAction = null;
  });

  $("close-reveal").addEventListener("click", () => {
    clearReveal();
    $("connections-title").focus();
  });
  $("copy-url").addEventListener("click", async () => {
    if (busy || !$("install-url").value) return;
    try {
      await navigator.clipboard.writeText($("install-url").value);
      notice("MCP URL copied. Paste it into your client's custom MCP server form.");
    } catch {
      $("install-url").focus();
      $("install-url").select();
      notice("Copy is unavailable. The URL is selected; copy it manually.");
    }
  });

  async function initialise() {
    show("checking");
    try {
      if (
        !window.isSecureContext ||
        !window.PublicKeyCredential ||
        !navigator.credentials?.create ||
        !navigator.credentials?.get
      ) {
        $("unavailable-message").textContent =
          "Use a browser that supports passkeys on this secure website.";
        show("unavailable");
        return;
      }
      const health = await request("/health");
      if (health.backend !== "durable-objects") {
        $("unavailable-message").textContent =
          "Account management is not enabled on this server yet. Check again after deploying the Worker.";
        show("unavailable");
        return;
      }
      await refresh();
    } catch {
      $("unavailable-message").textContent =
        "Account management could not be loaded. Check your connection and try again.";
      show("unavailable");
    }
  }

  $("check-again").addEventListener("click", () => run(initialise));

  window.addEventListener("pagehide", () => {
    activePasskey?.abort();
    clearReveal();
    clearKeys();
    session = null;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      clearReveal();
      clearKeys();
      if (busy) location.reload();
      else run(initialise);
    }
  });

  initialise();
})();
