from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_material_lot_runtime_mutation


class MaterialLot(Document):
    def validate(self):
        validate_material_lot_runtime_mutation(self)
        validate_business_document(self, "material_lot")
