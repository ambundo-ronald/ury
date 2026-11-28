import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

from ury.ury.station.eligibility import FORBIDDEN_ROLES


class URYStationSettings(Document):
	def validate(self):
		if cint(self.min_pin_length) < 4:
			frappe.throw(_("The minimum PIN length cannot be below 4."))
		if cint(self.max_pin_length) < cint(self.min_pin_length):
			frappe.throw(_("The maximum PIN length cannot be below the minimum."))
		if cint(self.idle_seconds) < 20:
			frappe.throw(_("Idle sign-out cannot be shorter than 20 seconds."))
		if cint(self.warning_seconds) >= cint(self.idle_seconds):
			frappe.throw(_("The warning must be shorter than the idle time."))
		if not (self.landing_page or "").startswith("/"):
			frappe.throw(_("Page After Sign-in must start with /."))

		self.validate_ticket_printing()

		refused = sorted({row.role for row in self.allowed_roles} & FORBIDDEN_ROLES)
		if refused:
			frappe.throw(_("These roles can never sign in with a PIN: {0}").format(", ".join(refused)))

	def validate_ticket_printing(self):
		from ury.ury.printing import queue

		if self.ticket_printing == queue.EACH_STATION:
			return
		self.fallback_agent = None
		shared = frappe.db.sql(
			"""SELECT row.printer, GROUP_CONCAT(row.parent ORDER BY row.parent SEPARATOR ', ')
			FROM `tabURY Print Agent Printer` row
			WHERE row.parenttype = 'URY Print Agent'
			GROUP BY row.printer HAVING COUNT(DISTINCT row.parent) > 1"""
		)
		if shared:
			printer, agents = shared[0]
			frappe.throw(
				_("Printer {0} is on several print agents ({1}). With one PC printing all tickets, keep it on one of them.").format(
					printer, agents
				)
			)
