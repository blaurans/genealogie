//! Assets embarqués dans le binaire via @embedFile.
pub const index_html = @embedFile("web/index.html");
pub const style_css = @embedFile("web/style.css");
pub const app_js = @embedFile("web/app.js");
pub const demo_ged = @embedFile("demo/demo.ged");
