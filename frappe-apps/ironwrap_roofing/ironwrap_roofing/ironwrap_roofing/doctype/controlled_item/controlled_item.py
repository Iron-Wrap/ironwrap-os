from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_controlled_item_runtime_mutation


class ControlledItem(Document):
    def validate(self):
        validate_controlled_item_runtime_mutation(self)
        validate_business_document(self, "controlled_item")
