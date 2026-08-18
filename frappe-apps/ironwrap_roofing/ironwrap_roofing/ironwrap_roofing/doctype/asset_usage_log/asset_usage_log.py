from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class AssetUsageLog(Document):
    def validate(self):
        validate_business_document(self, "asset_usage_log")
