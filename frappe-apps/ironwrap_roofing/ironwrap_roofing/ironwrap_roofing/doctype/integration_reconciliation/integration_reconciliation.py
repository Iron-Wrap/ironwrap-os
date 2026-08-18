from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_facet_design_projection_reconciliation_mutation
from ironwrap_roofing.document_validation import validate_quickbooks_final_invoice_mutation


class IntegrationReconciliation(Document):
    def validate(self) -> None:
        validate_quickbooks_final_invoice_mutation(self)
        validate_facet_design_projection_reconciliation_mutation(self)
        validate_business_document(self, "integration_reconciliation")
