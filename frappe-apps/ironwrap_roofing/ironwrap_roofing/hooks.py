from ironwrap_roofing.access_control import DOCTYPE_ROLE_MATRIX


app_name = "ironwrap_roofing"
app_title = "IronWrap Roofing"
app_publisher = "IronWrap Exteriors"
app_description = "Roofing operating DocTypes for IronWrap OS"
app_email = "sales@ironwrapexteriors.com"
app_license = "Proprietary"

before_install = "ironwrap_roofing.install.before_install"
after_install = "ironwrap_roofing.install.after_install"
before_migrate = "ironwrap_roofing.install.before_migrate"
after_migrate = "ironwrap_roofing.install.after_migrate"

doc_events = {
    doctype: {
        "on_trash": "ironwrap_roofing.document_validation.deny_business_document_delete"
    }
    for doctype in DOCTYPE_ROLE_MATRIX
}
