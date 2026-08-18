from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_asset_inspection_runtime_mutation
from ironwrap_roofing.document_validation import validate_business_document


class AssetInspection(Document):
    def validate(self):
        validate_asset_inspection_runtime_mutation(self)
        validate_business_document(self, "asset_inspection")
