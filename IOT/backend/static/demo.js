(() => {
  const $ = (sel) => document.querySelector(sel);
  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };

  async function refresh() {
    try {
      const res = await fetch("/api/status/", { cache: "no-store" });
      if (!res.ok) throw new Error("status " + res.status);
      const json = await res.json();
      const d = json.data || {};
      set("[data-status]", d.status || "—");
      set("[data-valve]", d.valve_open ? "OPEN" : "CLOSED");
      set("[data-serial]", d.serial_connected ? "ONLINE" : "OFFLINE");
      set("[data-ai-mode]", (d.ai && d.ai.mode) || "—");
      set("[data-inlet-text]", (d.inlet_display && d.inlet_display.text) || "0 mL/min");
      set("[data-outlet-text]", (d.outlet_display && d.outlet_display.text) || "0 mL/min");
      set("[data-loss-text]", (d.loss_display && d.loss_display.text) || "0 mL/min");
      set(
        "[data-vin-text]",
        (d.inlet_volume_display && d.inlet_volume_display.text) || "0 mL"
      );
      set(
        "[data-vout-text]",
        (d.outlet_volume_display && d.outlet_volume_display.text) || "0 mL"
      );
      const press = d.pressure || {};
      set(
        "[data-pressure]",
        press.available
          ? `balance ${press.balance_pct}% · drop ${press.drop_proxy_pct}%`
          : press.summary || "—"
      );
      set("[data-line]", d.last_serial_line || "—");
      set("[data-learn]", String((d.ai && d.ai.learn_samples) || 0));

      const est = d.break_estimate || {};
      set(
        "[data-estimate]",
        est.summary ||
          "Idle until water flows. Noise below 0.30 L/min is ignored."
      );
      const showMeters = !!est.available && est.distance_from_s1_m != null;
      set(
        "[data-est-s1]",
        showMeters ? Number(est.distance_from_s1_m).toFixed(0) : "—"
      );
      set(
        "[data-est-s2]",
        showMeters ? Number(est.distance_from_s2_m).toFixed(0) : "—"
      );
      set(
        "[data-est-sev]",
        est.available && est.severity_pct != null
          ? Number(est.severity_pct).toFixed(0)
          : "—"
      );
      set("[data-est-conf]", est.available ? est.confidence || "medium" : "none");

      const hist = d.history_means || [];
      if (hist.length) {
        set(
          "[data-history]",
          hist
            .slice(0, 8)
            .map((h) => {
              const t = (h.recorded_at || "").replace("T", " ").slice(0, 19);
              return (
                `${t}  mean in ${Number(h.mean_inlet_lpm).toFixed(2)} / out ${Number(h.mean_outlet_lpm).toFixed(2)} L/min` +
                `  vol +${Number(h.volume_in_ml).toFixed(0)}/${Number(h.volume_out_ml).toFixed(0)} mL`
              );
            })
            .join("\n")
        );
      } else {
        set("[data-history]", "No history windows yet — pour water for ~10 s.");
      }

      const flash = $("[data-cmd-flash]");
      if (flash && d.last_command_result) {
        flash.textContent = `Last command: ${d.last_command_result}`;
      }
    } catch (_) {
      set("[data-serial]", "API ERROR");
      set("[data-status]", "OFFLINE");
    }
  }

  document.querySelectorAll("[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const command = btn.getAttribute("data-cmd");
      if (!command) return;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = command === "RESET" ? "Restarting…" : "Sending…";
      set("[data-cmd-flash]", `Sending ${command}…`);
      try {
        const res = await fetch("/api/command/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) {
          set(
            "[data-cmd-flash]",
            `Failed: ${(json && json.message) || res.status}`
          );
        } else {
          set(
            "[data-cmd-flash]",
            command === "RESET"
              ? "Restarted: totals cleared, valve OPEN"
              : `OK: ${command}`
          );
        }
        await refresh();
        // Second refresh after Arduino ACK
        setTimeout(refresh, 800);
      } catch (err) {
        set("[data-cmd-flash]", `Error: ${err && err.message ? err.message : err}`);
      } finally {
        btn.textContent = label;
        btn.disabled = false;
      }
    });
  });

  refresh();
  setInterval(refresh, 1000);
})();
