window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    var SLOT = "sidebar.workspaces.session.menu.item";
    var CURRENT_KEY = "dsh.sessions.current";

    function closeMenu(props, state) {
      try {
        if (Array.isArray(state) && typeof state[1] === "function") {
          state[1](false);
          return;
        }
        if (typeof props.onClose === "function") {
          props.onClose();
          return;
        }
      } catch (error) {
        /* fall through to Escape */
      }
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } catch (error) {
        /* the menu owner may already have closed it */
      }
    }

    /** The conversation the app restored as the open one, when it is stored locally. */
    function currentSessionId() {
      try {
        var raw = window.localStorage.getItem(CURRENT_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed.sessionId === "string" ? parsed.sessionId : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * Drop the stored "what was open" pointers for the deleted Session, so a
     * reload does not try to restore a conversation whose log is gone.
     */
    function forgetLocalState(sessionId) {
      try {
        if (currentSessionId() === sessionId) window.localStorage.removeItem(CURRENT_KEY);
        window.localStorage.removeItem("dsh.conversation." + sessionId);
        window.localStorage.removeItem("dsh.sidebar-right.v1." + sessionId);
      } catch (error) {
        /* storage can be unavailable; the reload still proceeds */
      }
    }

    /** Re-pull the Session list through the client Session controller. */
    function refreshSessionList(ctx) {
      try {
        var sessions = null;
        if (ctx && typeof ctx.get === "function") sessions = ctx.get("sessions");
        if (!sessions && ctx) sessions = ctx.sessions;
        if (sessions && typeof sessions.refresh === "function") return sessions.refresh();
      } catch (error) {
        /* the service may not be injected yet */
      }
      return null;
    }

    function requestDelete(sessionId) {
      var urls = ["/dsh-session-delete/api/delete"];
      try {
        if (location.protocol === "http:" && location.port !== "") {
          urls.push("http://127.0.0.1:" + location.port + "/dsh-session-delete/api/delete");
        }
      } catch (error) {
        /* no location */
      }

      function attempt(index) {
        var url = urls[index];
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId }),
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (!response.ok) {
              if ((response.status === 404 || response.status === 405) && index + 1 < urls.length) {
                return attempt(index + 1);
              }
              var message = body && body.error && body.error.message
                ? body.error.message
                : "HTTP " + response.status;
              throw new Error(message);
            }
            return body;
          });
        }).catch(function (error) {
          if (error && error.__http) throw error;
          if (index + 1 < urls.length) return attempt(index + 1);
          throw error;
        });
      }
      return attempt(0);
    }

    function DeleteSessionItem(props) {
      var menuState = null;
      try {
        if (typeof props.useMenuOpenState === "function") menuState = props.useMenuOpenState();
        else if (Array.isArray(props.menuOpenState)) menuState = props.menuOpenState;
      } catch (error) {
        menuState = null;
      }

      function reload() {
        if (typeof window !== "undefined" && window.location) window.location.reload();
      }

      function settle(deletedId) {
        var wasOpen = currentSessionId() === deletedId;
        forgetLocalState(deletedId);
        // The open conversation itself holds the session, so only a reload
        // resets the main view away from a log that no longer exists.
        if (wasOpen || typeof window === "undefined") {
          reload();
          return;
        }
        var pending = typeof props.refreshSessions === "function" ? props.refreshSessions() : null;
        if (pending === null || pending === undefined) {
          reload();
          return;
        }
        Promise.resolve(pending).then(function () {}, function () { reload(); });
      }

      function run() {
        closeMenu(props, menuState);
        var title = props.displayTitle || props.sessionId || "当前会话";
        var question = "删除会话「" + title + "」？\n"
          + "运行中的会话会先被停止；日志和投影缓存会移到系统回收站。\n"
          + "在本次 DSH 运行中打开过的会话会立即从侧栏隐藏，并在 DSH 重启后彻底消失。";
        if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(question)) return;
        requestDelete(props.sessionId).then(function (body) {
          settle((body && body.sessionId) || props.sessionId);
        }).catch(function (error) {
          if (typeof window !== "undefined" && typeof window.alert === "function") {
            window.alert("删除失败：" + (error && error.message ? error.message : String(error)));
          }
        });
      }

      return h("button", {
        type: "button",
        role: "menuitem",
        className: "dsd-menu-item",
        onClick: run,
      }, "删除会话");
    }

    function apply(ctx) {
      ctx.effect(function () {
        var style = document.createElement("style");
        style.dataset.plugin = "dsh-session-delete";
        style.textContent = [
          ".dsd-menu-item{display:flex;align-items:center;width:100%;min-height:28px;padding:5px 10px;",
          "border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#ececec);",
          "font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}",
          ".dsd-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
          ".dsd-menu-item:focus-visible{outline:1px solid var(--dsw-alias-accent,#4a9eff);outline-offset:1px}",
        ].join("");
        document.head.appendChild(style);
        return function () { style.remove(); };
      }, "dsh-session-delete: styles");

      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({
          name: SLOT,
          id: "dsh-session-delete",
          order: 900,
          // Handed to the menu entry so it can refresh the Session list in place
          // instead of reloading the whole page.
          inject: function () {
            return { refreshSessions: function () { return refreshSessionList(ctx); } };
          },
        }, DeleteSessionItem);
      });
    }

    return { apply: apply, inject: ["slots"] };
  }
});
