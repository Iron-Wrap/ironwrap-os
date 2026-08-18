from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_cargo_load_runtime_mutation


class CargoLoad(Document):
    def validate(self):
        validate_cargo_load_runtime_mutation(self)
        validate_business_document(self, "cargo_load")
