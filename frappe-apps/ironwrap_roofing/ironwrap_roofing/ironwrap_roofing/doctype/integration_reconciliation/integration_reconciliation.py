from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class IntegrationReconciliation(Document):
    def validate(self) -> None:
        validate_business_document(self, "integration_reconciliation")
