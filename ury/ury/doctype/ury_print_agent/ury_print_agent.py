import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_to_date, now_datetime

PAIRING_MINUTES = 10


class URYPrintAgent(Document):
	def validate(self):
		self.agent_name = (self.agent_name or "").strip()
		seen = set()
		for row in self.printers:
			row.windows_printer = (row.windows_printer or "").strip()
			if row.printer in seen:
				frappe.throw(_("Printer {0} is listed twice.").format(row.printer))
			seen.add(row.printer)

		# A printer belongs to one agent, or two PCs would print every ticket.
		if seen:
			taken = frappe.get_all(
				"URY Print Agent Printer",
				filters={"printer": ["in", list(seen)], "parent": ["!=", self.name], "parenttype": "URY Print Agent"},
				fields=["printer", "parent"],
			)
			if taken:
				frappe.throw(
					_("Printer {0} is already printed by agent {1}.").format(taken[0].printer, taken[0].parent)
				)

	@frappe.whitelist()
	def new_pairing_code(self):
		"""One-time code typed into the URY POS Windows app to pair it with this agent."""
		from ury.ury.printing import agent

		self.check_permission("write")
		code = agent.new_code()
		self.db_set(
			{
				"pairing_code_hash": agent.hash_secret(self.name, code),
				"pairing_expires": add_to_date(now_datetime(), minutes=PAIRING_MINUTES),
			},
			update_modified=False,
		)
		return {"code": code, "minutes": PAIRING_MINUTES}

	@frappe.whitelist()
	def unpair(self):
		self.check_permission("write")
		self.db_set({"token_hash": None, "paired_on": None}, update_modified=False)
