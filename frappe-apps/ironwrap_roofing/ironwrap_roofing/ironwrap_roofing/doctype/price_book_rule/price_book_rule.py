from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class PriceBookRule(Document):
    def validate(self):
        validate_business_document(self, "price_book_rule")
