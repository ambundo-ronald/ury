"""One way to send a document to a printer, whoever does the printing.

A printer (Network Printer Settings) is printed either by a print server
(CUPS, reached from the Frappe server) or by a URY print agent: the URY POS
Windows app on a PC at the restaurant. A printer listed on an enabled
URY Print Agent goes to that agent; every other printer goes to CUPS.

Agent printing queues a URY Print Job that the agent collects. CUPS printing
happens at once, and a failure is kept as a Failed job so the POS can alert
the cashier and print it again instead of losing the ticket.
"""

import frappe
from frappe import _
from frappe.utils import add_to_date, get_datetime, now_datetime

ALERT_EVENT = "ury_print_alert_{branch}"


# URY Station Settings > Ticket Printing
ONE_PC = "One PC prints all tickets"
EACH_STATION = "Each station prints its own orders"
# A station PC not heard from for this long is treated as off (it asks every 3 s).
STATION_AGENT_OFFLINE_SECONDS = 30


def per_station_printing():
	"""True when each station prints the tickets of its own orders."""
	from ury.ury.station.pin import get_settings

	return get_settings().ticket_printing == EACH_STATION


def agents_with_printer(printer_setting):
	"""Enabled print agents that have this printer, oldest first."""
	if not printer_setting or not isinstance(printer_setting, str):
		return []
	# One query, so callers' tests that mock frappe.get_all are unaffected.
	agent = frappe.qb.DocType("URY Print Agent")
	row = frappe.qb.DocType("URY Print Agent Printer")
	return (
		frappe.qb.from_(row)
		.join(agent)
		.on(agent.name == row.parent)
		.select(agent.name)
		.where(row.parenttype == "URY Print Agent")
		.where(row.printer == printer_setting)
		.where(agent.enabled == 1)
		.orderby(agent.creation)
		.run(pluck=True)
	)


def _station_agent():
	"""The print agent of the station this request comes from, if any."""
	from ury.ury.station.session import current_station

	station = current_station()
	return frappe.db.get_value("URY Station", station, "print_agent") if station else None


def _recently_seen(agent):
	last_seen = frappe.db.get_value("URY Print Agent", agent, "last_seen")
	return bool(last_seen) and get_datetime(last_seen) >= add_to_date(
		now_datetime(), seconds=-STATION_AGENT_OFFLINE_SECONDS
	)


def agent_for_printer(printer_setting):
	"""The enabled print agent that should print this ticket, or None.

	Usually one agent has the printer. With "Each station prints its own
	orders", several do: the station that took the order prints it if its PC
	is on; anything else goes to the fallback PC.
	"""
	agents = agents_with_printer(printer_setting)
	if len(agents) <= 1:
		return agents[0] if agents else None
	if per_station_printing():
		station_agent = _station_agent()
		if station_agent in agents and _recently_seen(station_agent):
			return station_agent
		from ury.ury.station.pin import get_settings

		fallback = get_settings().fallback_agent
		if fallback in agents:
			return fallback
	return agents[0]


def _new_job(doctype, name, printer_setting, print_format, branch, label, agent):
	return frappe.get_doc(
		{
			"doctype": "URY Print Job",
			"status": "Queued",
			"label": (label or f"{doctype} {name}")[:140],
			"branch": branch or (frappe.db.get_value("URY Print Agent", agent, "branch") if agent else None),
			"printer": printer_setting,
			"agent": agent,
			"reference_doctype": doctype,
			"reference_name": name,
			"print_format": print_format,
			"requested_by": frappe.session.user,
		}
	)


def send_html(doctype, name, printer_setting, html, print_format=None, branch=None, label=None):
	"""Queue already rendered HTML for an agent printer (for documents built in memory)."""
	agent = agent_for_printer(printer_setting)
	if not agent:
		frappe.throw(_("Printer {0} has no print agent.").format(printer_setting))
	job = _new_job(doctype, name, printer_setting, print_format, branch, label, agent)
	job.content = html
	job.insert(ignore_permissions=True)
	return "Queued"


def send(doctype, name, printer_setting, print_format=None, branch=None, label=None):
	"""Print a document on a printer. Returns "Queued", "Printed" or "Failed"."""
	agent = agent_for_printer(printer_setting)
	job = _new_job(doctype, name, printer_setting, print_format, branch, label, agent)
	if agent:
		job.insert(ignore_permissions=True)
		return "Queued"

	error = print_with_cups(doctype, name, printer_setting, print_format)
	if not error:
		return "Printed"
	job.status = "Failed"
	job.attempts = 1
	job.error = error
	job.insert(ignore_permissions=True)
	alert(job)
	return "Failed"


def print_with_cups(doctype, name, printer_setting, print_format):
	"""Print through the print server. Returns an error message, or None."""
	from frappe.utils.print_format import print_by_server

	try:
		import cups  # noqa: F401
	except ImportError:
		# A cloud site has no print server; the printer most likely just
		# needs adding to the print agent. Say that instead of "install pycups".
		return _(
			"Printer {0} is not on any URY Print Agent. Add it to the agent's Printers table "
			"(this server has no print server of its own)."
		).format(printer_setting)

	try:
		print_by_server(doctype, name, printer_setting, print_format)
		return None
	except Exception as e:
		frappe.clear_last_message()
		return str(e) or e.__class__.__name__


def retry(job_name):
	"""Print a failed or stuck job again."""
	job = frappe.get_doc("URY Print Job", job_name)
	if job.status == "Printed":
		frappe.throw(_("This was already printed."))

	agent = agent_for_printer(job.printer)
	if agent or job.content:
		if not agent:
			frappe.throw(_("Printer {0} no longer has a print agent.").format(job.printer))
		job.db_set({"status": "Queued", "agent": agent, "claimed_at": None, "error": None})
		return "Queued"

	error = print_with_cups(job.reference_doctype, job.reference_name, job.printer, job.print_format)
	if error:
		job.db_set({"status": "Failed", "attempts": (job.attempts or 0) + 1, "error": error})
		return "Failed"
	job.db_set({"status": "Printed", "printed_at": now_datetime(), "error": None, "agent": None})
	return "Printed"


def delete_old_jobs(days=30):
	"""Daily: the queue is a working list, not an archive."""
	from frappe.utils import add_days

	frappe.db.delete("URY Print Job", {"creation": ["<", add_days(now_datetime(), -days)]})


def alert(job):
	"""Tell the branch's POS screens at once that a job did not print."""
	if not job.branch:
		return
	frappe.publish_realtime(
		ALERT_EVENT.format(branch=job.branch),
		{"job": job.name, "label": job.label, "printer": job.printer, "error": job.error},
		after_commit=True,
	)
