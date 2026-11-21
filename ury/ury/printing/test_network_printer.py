"""Network Printer Settings can be filled in without a print server (CUPS)."""

import sys
import types
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from ury.ury.printing.network_printer import URYNetworkPrinterSettings

NAME = "URY Test Typed Printer"


def _fake_cups(printers=None, fail=False):
	module = types.ModuleType("cups")
	module.setServer = lambda ip: None
	module.setPort = lambda port: None

	class Connection:
		def __init__(self):
			if fail:
				raise RuntimeError("no print server")

		def getPrinters(self):
			return printers or {}

	module.Connection = Connection
	return module


def _new(printer_name=None):
	doc = frappe.new_doc("Network Printer Settings")
	doc.update({"server_ip": "203.0.113.10", "port": 631, "printer_name": printer_name})
	return doc


class TestNetworkPrinterWithoutCups(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.local.message_log = []
		if frappe.db.exists("Network Printer Settings", NAME):
			frappe.delete_doc("Network Printer Settings", NAME, force=True)

	def test_uses_the_ury_class(self):
		self.assertIsInstance(_new(), URYNetworkPrinterSettings)

	def test_no_pycups_gives_no_printers_and_no_error(self):
		with patch.dict(sys.modules, {"cups": None}):
			self.assertEqual(_new().get_printers_list(), [])
			self.assertEqual(
				_new("Kitchen").get_printers_list(), [{"value": "Kitchen", "label": "Kitchen"}]
			)
		self.assertEqual(frappe.local.message_log, [])

	def test_unreachable_print_server_gives_no_printers_and_no_error(self):
		with patch.dict(sys.modules, {"cups": _fake_cups(fail=True)}):
			self.assertEqual(_new("Bar").get_printers_list(), [{"value": "Bar", "label": "Bar"}])
		self.assertEqual(frappe.local.message_log, [])

	def test_print_server_printers_are_listed(self):
		printers = {"XP80": {"printer-make-and-model": "Xprinter XP-80"}}
		with patch.dict(sys.modules, {"cups": _fake_cups(printers)}):
			self.assertEqual(
				_new("Typed").get_printers_list(), [{"value": "XP80", "label": "Xprinter XP-80"}]
			)

	def test_needs_write_permission(self):
		frappe.set_user("Guest")
		try:
			with patch.dict(sys.modules, {"cups": None}):
				self.assertRaises(frappe.PermissionError, _new("Kitchen").get_printers_list)
		finally:
			frappe.set_user("Administrator")

	def test_a_typed_printer_name_saves(self):
		doc = _new("Kitchen Printer (typed)")
		doc.insert(set_name=NAME)
		self.assertEqual(
			frappe.db.get_value("Network Printer Settings", NAME, "printer_name"), "Kitchen Printer (typed)"
		)
