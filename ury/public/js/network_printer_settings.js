// Without a print server (CUPS) the Printer Name list is empty, for example on
// a cloud site printing through the URY Windows app. Let the name be typed.
frappe.ui.form.on("Network Printer Settings", {
	refresh(frm) {
		if (!frm.perm[0].write) return;
		frm.set_df_property(
			"printer_name",
			"description",
			__(
				"Not in the list? Click Type Printer Name. Printers printed by the URY Windows app need no print server: use any name, then pick this printer in the URY Print Agent."
			)
		);
		frm.add_custom_button(__("Type Printer Name"), () => {
			frappe.prompt(
				{
					fieldname: "printer_name",
					fieldtype: "Data",
					label: __("Printer Name"),
					reqd: 1,
					default: frm.doc.printer_name,
				},
				({ printer_name }) => {
					const name = printer_name.trim();
					const field = frm.get_field("printer_name");
					const options = field.df.options || [];
					const current = Array.isArray(options) ? options : String(options).split("\n");
					const known = current.some((o) => (o && o.value ? o.value : o) === name);
					if (!known) frm.set_df_property("printer_name", "options", current.concat([name]));
					frm.set_value("printer_name", name);
				},
				__("Printer Name"),
				__("Set")
			);
		});
	},
});
