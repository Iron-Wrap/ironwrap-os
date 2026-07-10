from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class ChangeOrder(Document):
    def validate(self):
        validate_business_document(self, "change_order")
