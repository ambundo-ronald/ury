"""What the POS needs to warn the cashier about printing, and to fix it."""

import frappe
from frappe import _
from frappe.utils import add_to_date, now_datetime

from ury.ury import roles
from ury.ury.printing import queue

# How long a ticket may wait before the POS says the agent is not printing.
WAITING_SECONDS = 45
# An agent not heard from for this long is shown as offline.
OFFLINE_SECONDS = 90
LOOKBACK_HOURS = 12


def _branch():
	from ury.ury_pos.api import getBranch

	try:
		return getBranch()
	except Exception:
		frappe.clear_last_message()
		return None


def _require_cashier():
	if not roles.can_bill():
		frappe.throw(_("Only a cashier or manager can do this."), frappe.PermissionError)


@frappe.whitelist()
def get_print_problems():
	"""Failed jobs, jobs waiting too long, and offline agents for the user's branch."""
	if not roles.can_bill():
		return {"failed": [], "waiting": [], "offline_agents": []}
	branch = _branch()
	if not branch:
		return {"failed": [], "waiting": [], "offline_agents": []}

	now = now_datetime()
	since = add_to_date(now, hours=-LOOKBACK_HOURS)
	fields = ["name", "label", "printer", "error", "creation", "status"]
	failed = frappe.get_all(
		"URY Print Job",
		filters={"branch": branch, "status": "Failed", "creation": [">", since]},
		fields=fields,
		order_by="creation desc",
		limit=50,
	)
	waiting = frappe.get_all(
		"URY Print Job",
		filters={
			"branch": branch,
			"status": ["in", ["Queued", "Printing"]],
			"creation": ["between", [since, add_to_date(now, seconds=-WAITING_SECONDS)]],
		},
		fields=fields,
		order_by="creation",
		limit=50,
	)
	offline_agents = [
		a
		for a in frappe.get_all(
			"URY Print Agent",
			filters={"branch": branch, "enabled": 1},
			fields=["name", "last_seen"],
		)
		if not a.last_seen or a.last_seen < add_to_date(now, seconds=-OFFLINE_SECONDS)
	]
	return {"failed": failed, "waiting": waiting, "offline_agents": offline_agents}


def _job_in_branch(job):
	branch = _branch()
	if not branch or frappe.db.get_value("URY Print Job", job, "branch") != branch:
		frappe.throw(_("This print job is not in your branch."), frappe.PermissionError)


@frappe.whitelist(methods=["POST"])
def retry_print_job(job):
	_require_cashier()
	_job_in_branch(job)
	return {"status": queue.retry(job)}


@frappe.whitelist(methods=["POST"])
def dismiss_print_job(job):
	"""The cashier dealt with it another way (e.g. told the kitchen)."""
	_require_cashier()
	_job_in_branch(job)
	status = frappe.db.get_value("URY Print Job", job, "status")
	if status in ("Failed", "Queued", "Printing"):
		frappe.db.set_value("URY Print Job", job, "status", "Cancelled")
	return {"status": "Cancelled"}
