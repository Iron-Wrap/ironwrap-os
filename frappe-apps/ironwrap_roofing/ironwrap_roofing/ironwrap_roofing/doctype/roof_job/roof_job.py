from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import (
    validate_customer_contract_job_transition_mutation,
)
from ironwrap_roofing.document_validation import validate_quickbooks_final_invoice_mutation


class RoofJob(Document):
    def validate(self):
        validate_customer_contract_job_transition_mutation(self)
        validate_quickbooks_final_invoice_mutation(self)
        validate_business_document(self, "roof_job")
