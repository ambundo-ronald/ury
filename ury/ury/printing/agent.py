"""Endpoints for the URY print agent (the URY POS Windows app).

The agent is not a user. A manager pairs it once with a one-time code from
the URY Print Agent form; it then sends its token in the X-URY-Agent-Token
header. It only makes outgoing HTTPS requests, so the restaurant needs no
VPN or open ports.

The agent polls every few seconds: `poll` reports it alive and hands it the
jobs for its printers with the HTML to print, `report` records the result.
"""

import hashlib
import hmac
import secrets

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from ury.ury.printing import queue

TOKEN_HEADER = "X-URY-Agent-Token"
# A job sent to the agent but never reported is offered again after this.
CLAIM_SECONDS = 120
MAX_JOBS_PER_POLL = 10
# Jobs older than this are not printed: a ticket hours late does more harm than good.
STALE_HOURS = 12


def new_code():
	return f"{secrets.randbelow(10**6):06d}"


def hash_secret(agent, secret):
	return hashlib.sha256(f"{agent}:{secret}".encode()).hexdigest()


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=10, seconds=10 * 60)
def pair(agent_name, code):
	"""Swap a one-time pairing code for the agent's long-lived token."""
	agent_name = (agent_name or "").strip()
	code = (code or "").strip()
	row = frappe.db.get_value(
		"URY Print Agent",
		agent_name,
		["name", "enabled", "pairing_code_hash", "pairing_expires", "branch"],
		as_dict=True,
	)
	if (
		not row
		or not row.enabled
		or not row.pairing_code_hash
		or not row.pairing_expires
		or get_datetime(row.pairing_expires) < now_datetime()
		or not hmac.compare_digest(row.pairing_code_hash, hash_secret(row.name, code))
	):
		frappe.throw(_("Wrong agent name or pairing code, or the code has expired."), frappe.AuthenticationError)

	token = secrets.token_urlsafe(32)
	frappe.db.set_value(
		"URY Print Agent",
		row.name,
		{
			"token_hash": hash_secret(row.name, token),
			"pairing_code_hash": None,
			"pairing_expires": None,
			"paired_on": now_datetime(),
		},
		update_modified=False,
	)
	return {"agent": row.name, "token": token, "branch": row.branch}


def _authenticate():
	"""The agent named in the token header, or AuthenticationError."""
	raw = frappe.get_request_header(TOKEN_HEADER) or ""
	agent_name, _sep, token = raw.partition(":")
	if agent_name and token:
		row = frappe.db.get_value("URY Print Agent", agent_name, ["name", "enabled", "token_hash"], as_dict=True)
		if row and row.enabled and row.token_hash and hmac.compare_digest(row.token_hash, hash_secret(row.name, token)):
			return row.name
	frappe.throw(_("This print agent is not paired. Pair it again from the URY Print Agent form."), frappe.AuthenticationError)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def poll(printers=None, app_version=None):
	"""Heartbeat, then claim and render the next jobs for this agent's printers."""
	agent = _authenticate()
	update = {"last_seen": now_datetime()}
	if printers is not None:
		names = frappe.parse_json(printers) if isinstance(printers, str) else printers
		update["detected_printers"] = "\n".join(str(p) for p in (names or []))[:5000]
	if app_version:
		update["app_version"] = str(app_version)[:40]
	frappe.db.set_value("URY Print Agent", agent, update, update_modified=False)

	mapping = dict(
		frappe.get_all(
			"URY Print Agent Printer",
			filters={"parent": agent, "parenttype": "URY Print Agent"},
			fields=["printer", "windows_printer"],
			as_list=True,
		)
	)
	if not mapping:
		return {"jobs": []}

	now = now_datetime()
	job_table = frappe.qb.DocType("URY Print Job")
	waiting = (
		frappe.qb.from_(job_table)
		.select(job_table.name)
		.where(job_table.printer.isin(list(mapping)))
		.where(job_table.creation > add_to_date(now, hours=-STALE_HOURS))
		.where(
			(job_table.status == "Queued")
			| ((job_table.status == "Printing") & (job_table.claimed_at < add_to_date(now, seconds=-CLAIM_SECONDS)))
		)
		.orderby(job_table.creation)
		.limit(MAX_JOBS_PER_POLL)
		.for_update(skip_locked=True)
		.run(pluck=True)
	)

	jobs = []
	for name in waiting:
		job = frappe.get_doc("URY Print Job", name)
		try:
			html = render(job)
		except Exception as e:
			job.db_set({"status": "Failed", "attempts": (job.attempts or 0) + 1, "error": f"Could not prepare the print: {e}"})
			queue.alert(job)
			continue
		job.db_set(
			{"status": "Printing", "agent": agent, "claimed_at": now, "attempts": (job.attempts or 0) + 1},
			update_modified=False,
		)
		jobs.append(
			{
				"job": job.name,
				"label": job.label,
				"printer": mapping[job.printer],
				"html": html,
			}
		)
	return {"jobs": jobs}


def render(job):
	"""The document as a standalone HTML page, with absolute links to this site."""
	from frappe.utils import scrub_urls

	if job.content:
		return scrub_urls(job.content)
	frappe.flags.ignore_print_permissions = True
	try:
		html = frappe.get_print(job.reference_doctype, job.reference_name, job.print_format or None, no_letterhead=1)
	finally:
		frappe.flags.ignore_print_permissions = False
	return scrub_urls(html)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def report(job, ok, error=None):
	"""Record whether the agent printed a job."""
	agent = _authenticate()
	doc = frappe.db.get_value("URY Print Job", job, ["name", "agent", "status"], as_dict=True)
	if not doc or doc.agent != agent:
		frappe.throw(_("This job is not this agent's."), frappe.PermissionError)
	if doc.status in ("Printed", "Cancelled"):
		return {"status": doc.status}

	job_doc = frappe.get_doc("URY Print Job", job)
	if cint(ok):
		job_doc.db_set({"status": "Printed", "printed_at": now_datetime(), "error": None})
	else:
		job_doc.db_set({"status": "Failed", "error": (error or _("The printer did not accept the job."))[:1000]})
		queue.alert(job_doc)
	return {"status": job_doc.status}
