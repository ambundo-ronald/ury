"""Network Printer Settings without a print server.

Frappe's form fills the required Printer Name dropdown only from a CUPS print
server, and shows an error when pycups is missing or no server answers. A
cloud site printing through the URY Windows app has neither, so the form could
not be saved. Here the lookup returns no printers instead of an error, and
the form script (public/js/network_printer_settings.js) lets the name be typed.
"""

import frappe
from frappe.printing.doctype.network_printer_settings.network_printer_settings import (
	NetworkPrinterSettings,
)


class URYNetworkPrinterSettings(NetworkPrinterSettings):
	@frappe.whitelist()
	def get_printers_list(self, ip: str = "127.0.0.1", port: int = 631):
		self.check_permission("write")
		try:
			import cups  # noqa: F401
		except ImportError:
			return self._typed_printer()
		try:
			printers = super().get_printers_list(ip, port) or []
		except frappe.ValidationError:
			# "Failed to connect to server": no print server at this address.
			frappe.clear_last_message()
			return self._typed_printer()
		return printers or self._typed_printer()

	def _typed_printer(self):
		# Keep a name typed earlier selectable, since there is no list to show it.
		if self.printer_name:
			return [{"value": self.printer_name, "label": self.printer_name}]
		return []
