from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_customer_quote_acceptance_mutation


class CustomerQuote(Document):
    def validate(self):
        validate_customer_quote_acceptance_mutation(self)
        validate_business_document(self, "customer_quote")
