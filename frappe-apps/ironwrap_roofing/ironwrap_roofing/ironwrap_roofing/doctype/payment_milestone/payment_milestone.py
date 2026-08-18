from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_quickbooks_final_invoice_mutation


class PaymentMilestone(Document):
    def validate(self):
        validate_quickbooks_final_invoice_mutation(self)
        validate_business_document(self, "payment_milestone")
