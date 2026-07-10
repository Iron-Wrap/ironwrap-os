frappe.pages["ironwrap-control-center"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: __("IronWrap Control Center"),
		single_column: true,
	});
	wrapper.ironwrap_control_center = new IronWrapControlCenter(wrapper);
};

frappe.pages["ironwrap-control-center"].on_page_show = function (wrapper) {
	wrapper.ironwrap_control_center?.refresh();
};

class IronWrapControlCenter {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.page = wrapper.page;
		this.request_serial = 0;
		this.targets = [];
		this.$root = $(
			`<main class="iw-control-center" aria-label="${__("IronWrap operating cockpit")}">
				<div class="iw-loading" role="status" aria-live="polite">${__("Loading operating truth…")}</div>
			</main>`
		).appendTo($(wrapper).find(".page-content").empty());

		this.job_field = this.page.add_field({
			label: __("Focus job"),
			fieldtype: "Link",
			fieldname: "roof_job",
			options: "Roof Job",
			change: () => this.refresh(),
		});
		this.page.add_inner_button(__("Refresh"), () => this.refresh());
		this.page.add_inner_button(__("Automation incidents"), () =>
			frappe.set_route("List", "Automation Incident")
		);
		this.bind_navigation();
	}

	async refresh() {
		const serial = ++this.request_serial;
		this.$root.attr("aria-busy", "true").html(
			`<div class="iw-loading" role="status">${__("Loading operating truth…")}</div>`
		);
		try {
			const response = await frappe.call({
				method: "ironwrap_roofing.ironwrap_roofing.page.ironwrap_control_center.ironwrap_control_center.get_control_center",
				args: { roof_job: this.job_field.get_value() || null },
			});
			if (serial !== this.request_serial) return;
			this.data = response.message || {};
			this.render();
		} catch (error) {
			if (serial !== this.request_serial) return;
			this.$root.html(`
				<section class="iw-error" role="alert">
					<p class="iw-eyebrow">${__("CONTROL CENTER UNAVAILABLE")}</p>
					<h2>${__("Operating truth could not be loaded")}</h2>
					<p>${__("No mutation was attempted. Check your role and the Frappe error log, then retry.")}</p>
					<button class="btn btn-primary btn-sm" data-iw-refresh>${__("Retry")}</button>
				</section>`);
		}
		this.$root.attr("aria-busy", "false");
	}

	bind_navigation() {
		this.$root.on("click.iw-control-center", "[data-iw-target]", (event) => {
			const target = this.targets[Number(event.currentTarget.dataset.iwTarget)];
			if (target?.doctype && target?.name) frappe.set_route("Form", target.doctype, target.name);
		});
		this.$root.on("click.iw-control-center", "[data-iw-refresh]", () => this.refresh());
	}

	register_target(doctype, name) {
		if (!doctype || !name) return null;
		const index = this.targets.push({ doctype, name }) - 1;
		return index;
	}

	target_button(doctype, name, label = __("Open record"), class_name = "iw-open") {
		const index = this.register_target(doctype, name);
		if (index === null) return "";
		return `<button class="${class_name}" data-iw-target="${index}">${this.escape(label)}</button>`;
	}

	render() {
		this.targets = [];
		const data = this.data;
		const metrics = data.metrics || {};
		const selected = data.selected || {};
		const bus = data.bus_readiness || { state: "not_configured" };
		const role = (data.roles || []).filter((item) => item !== "System Manager")[0] || data.roles?.[0] || __("Authorized user");
		this.page.set_title_sub(
			selected.job ? this.escape(selected.job.job_number || selected.job.roof_job_id || selected.job.name) : __("Exception-first operations")
		);

		this.$root.html(`
			<header class="iw-command-header">
				<div>
					<p class="iw-eyebrow">${__("OWNED OPERATING TRUTH")}</p>
					<h1>${__("See the stop before it becomes a delay.")}</h1>
					<p class="iw-lede">${__("Blocked gates, review work, incidents, and job evidence in one read-only control surface.")}</p>
				</div>
				<div class="iw-truth-stamp">
					<span>${__("READ-ONLY")}</span>
					<strong>${this.escape(role)}</strong>
					<small>${this.escape(this.format_date(data.generated_at))}</small>
				</div>
			</header>

			<section class="iw-metrics" aria-label="${__("Operating metrics")}">
				${this.metric(__("Active jobs"), metrics.active_jobs, __("Open operating records"), "neutral")}
				${this.metric(__("Blocked gates"), metrics.blocked_gates, __("Production stops"), metrics.blocked_gates ? "danger" : "good")}
				${this.metric(__("Pending reviews"), metrics.pending_reviews, __("Human decisions"), metrics.pending_reviews ? "warning" : "good")}
				${this.metric(__("Open incidents"), metrics.open_incidents, __("Automation recovery"), metrics.open_incidents ? "danger" : "good")}
				${this.metric(__("Stale jobs"), metrics.stale_jobs, __("No update in 72h"), metrics.stale_jobs ? "warning" : "good")}
				${this.metric(__("Bus readiness"), this.bus_label(bus.state), __("Public dependency probe"), bus.state === "ready" ? "good" : "warning")}
			</section>

			<section class="iw-panel iw-pipeline-panel">
				<div class="iw-section-heading">
					<div><p class="iw-eyebrow">${__("FLOW")}</p><h2>${__("Roofing pipeline")}</h2></div>
					<span>${__("Counts are permission-scoped")}</span>
				</div>
				<div class="iw-pipeline">${this.render_pipeline(data.pipeline || [])}</div>
			</section>

			<div class="iw-main-grid">
				<section class="iw-panel iw-actions-panel">
					<div class="iw-section-heading">
						<div><p class="iw-eyebrow">${__("ACT NOW")}</p><h2>${__("Action queue")}</h2></div>
						<span>${(data.action_queue || []).length} ${__("visible")}</span>
					</div>
					<div class="iw-action-list">${this.render_actions(data.action_queue || [])}</div>
				</section>

				<section class="iw-panel iw-job-panel">
					${this.render_selected_job(selected)}
				</section>
			</div>

			<div class="iw-lower-grid">
				<section class="iw-panel">
					<div class="iw-section-heading">
						<div><p class="iw-eyebrow">${__("EVIDENCE LEDGER")}</p><h2>${__("Latest job proof")}</h2></div>
						<span>${(selected.evidence || []).length} ${__("items")}</span>
					</div>
					${this.render_evidence(selected.evidence || [])}
				</section>

				<aside class="iw-panel iw-safety-panel">
					<p class="iw-eyebrow">${__("SAFE ACTION RAIL")}</p>
					<h2>${__("Read, verify, approve.")}</h2>
					<p>${this.escape(data.safety?.message || __("This surface never mutates operating records."))}</p>
					<ol>
						<li>${__("Open the source record and inspect linked evidence.")}</li>
						<li>${__("Run the matching dry-run through the authorized Hermes role.")}</li>
						<li>${__("Approve one stable run ID; verify its Hermes Run or bus audit.")}</li>
					</ol>
					<div class="iw-safety-links">
						${this.target_button("Automation Incident", (data.action_queue || []).find((item) => item.doctype === "Automation Incident")?.name, __("Open top incident"), "btn btn-default btn-sm")}
						<button class="btn btn-default btn-sm" data-iw-refresh>${__("Refresh truth")}</button>
					</div>
				</aside>
			</div>
		`);
	}

	metric(label, value, detail, tone) {
		return `<article class="iw-metric" data-tone="${tone}">
			<span>${this.escape(label)}</span>
			<strong>${this.escape(value ?? 0)}</strong>
			<small>${this.escape(detail)}</small>
		</article>`;
	}

	render_pipeline(rows) {
		if (!rows.length) return this.empty(__("No pipeline records are visible."));
		const max = Math.max(...rows.map((row) => Number(row.count || 0)), 1);
		return rows
			.map((row) => {
				const count = Number(row.count || 0);
				const width = count ? Math.max(8, Math.round((count / max) * 100)) : 0;
				return `<div class="iw-pipeline-stage">
					<div><span>${this.escape(row.status)}</span><strong>${count}</strong></div>
					<div class="iw-pipeline-track" aria-hidden="true"><i style="width:${width}%"></i></div>
				</div>`;
			})
			.join("");
	}

	render_actions(actions) {
		if (!actions.length) return this.empty(__("No blocked, failed, or review-ready records are visible."), true);
		return actions
			.map(
				(action) => `<article class="iw-action" data-priority="${Number(action.priority ?? 3)}">
					<div class="iw-action-marker" aria-hidden="true"></div>
					<div class="iw-action-copy">
						<div class="iw-action-meta"><span>${this.escape(action.kind)}</span><time>${this.escape(this.format_date(action.modified))}</time></div>
						<h3>${this.escape(action.summary)}</h3>
						<p>${this.escape(action.detail)}</p>
						<div class="iw-action-footer">
							${action.roof_job ? `<code>${this.escape(action.roof_job)}</code>` : `<code>${this.escape(action.doctype)}</code>`}
							${this.target_button(action.doctype, action.name)}
						</div>
					</div>
				</article>`
			)
			.join("");
	}

	render_selected_job(selected) {
		const job = selected.job;
		if (!job) {
			return `<div class="iw-section-heading"><div><p class="iw-eyebrow">${__("JOB RUNWAY")}</p><h2>${__("No visible job")}</h2></div></div>
				${this.empty(__("Choose a permitted Roof Job in the toolbar or create the first owned job record."), true)}`;
		}
		return `<div class="iw-section-heading">
			<div><p class="iw-eyebrow">${__("JOB RUNWAY")}</p><h2>${this.escape(job.job_number || job.roof_job_id || job.name)}</h2></div>
			${this.target_button("Roof Job", job.name, __("Open job"), "btn btn-default btn-sm")}
		</div>
		<div class="iw-job-meta">
			<span>${this.escape(job.brand || __("Brand not set"))}</span>
			<span>${this.escape(job.service_type || __("Service not set"))}</span>
			<strong>${this.escape(job.job_status || __("Unknown"))}</strong>
		</div>
		<div class="iw-runway">${this.render_runway(selected.runway || [])}</div>
		<div class="iw-gates">
			<h3>${__("Production gates")}</h3>
			${this.render_gates(selected.gates || [])}
		</div>`;
	}

	render_runway(runway) {
		return runway
			.map(
				(step) => `<div class="iw-runway-step" data-state="${this.escape(step.state)}">
					<i aria-hidden="true"></i>
					<div><strong>${this.escape(step.label)}</strong><span>${this.escape(step.detail)}</span></div>
				</div>`
			)
			.join("");
	}

	render_gates(gates) {
		if (!gates.length) return this.empty(__("No gate states are visible."));
		return `<div class="iw-gate-grid">${gates
			.map(
				(gate) => `<button class="iw-gate" data-state="${this.escape(String(gate.state || "Unknown").toLowerCase())}" data-iw-target="${this.register_target("Production Gate State", gate.name)}">
					<span>${this.escape(gate.gate)}</span><strong>${this.escape(gate.state)}</strong>
				</button>`
			)
			.join("")}</div>`;
	}

	render_evidence(evidence) {
		if (!evidence.length) return this.empty(__("No evidence has landed for the focused job."), true);
		return `<div class="iw-evidence-list">${evidence
			.map(
				(item) => `<button class="iw-evidence" data-iw-target="${this.register_target("Evidence Item", item.name)}">
					<span class="iw-evidence-icon" aria-hidden="true">${this.evidence_icon(item.evidence_type)}</span>
					<span><strong>${this.escape(item.evidence_type || __("Evidence"))}</strong><small>${this.escape(item.source_system || __("Owned record"))} · ${this.escape(this.format_date(item.captured_at || item.modified))}</small></span>
					<em>${item.customer_safe ? __("Customer-safe") : __("Internal")}</em>
				</button>`
			)
			.join("")}</div>`;
	}

	evidence_icon(type) {
		const value = String(type || "").toLowerCase();
		if (value.includes("photo")) return "PH";
		if (value.includes("voice")) return "VO";
		if (value.includes("measurement")) return "ME";
		if (value.includes("signed")) return "SG";
		return "EV";
	}

	empty(message, roomy = false) {
		return `<div class="iw-empty${roomy ? " iw-empty-roomy" : ""}"><span aria-hidden="true">—</span><p>${this.escape(message)}</p></div>`;
	}

	bus_label(state) {
		return {
			ready: __("Ready"),
			not_ready: __("Not ready"),
			unreachable: __("Unreachable"),
			not_configured: __("Not linked"),
			invalid_configuration: __("Invalid config"),
		}[state] || __("Unknown");
	}

	format_date(value) {
		if (!value) return __("No timestamp");
		try {
			return frappe.datetime.str_to_user(String(value).replace("T", " ").replace("Z", ""));
		} catch (_error) {
			return String(value);
		}
	}

	escape(value) {
		return frappe.utils.escape_html(String(value ?? ""));
	}
}
