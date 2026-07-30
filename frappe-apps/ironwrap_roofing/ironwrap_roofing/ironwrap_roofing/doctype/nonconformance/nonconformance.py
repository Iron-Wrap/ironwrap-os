from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_nonconformance_runtime_mutation


class Nonconformance(Document):
    def validate(self):
        validate_nonconformance_runtime_mutation(self)
        validate_business_document(self, "nonconformance")
