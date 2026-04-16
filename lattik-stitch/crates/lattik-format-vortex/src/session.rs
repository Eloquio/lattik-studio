use vortex::file::register_default_encodings;
use vortex::array::session::ArraySession;
use vortex::array::scalar_fn::session::ScalarFnSession;

/// Create a VortexSession with all default encodings registered.
pub fn make_session() -> vortex::session::VortexSession {
    let session = vortex::session::VortexSession::empty()
        .with::<ArraySession>()
        .with::<vortex::layout::session::LayoutSession>()
        .with::<ScalarFnSession>()
        .with::<vortex::io::session::RuntimeSession>();
    register_default_encodings(&session);
    session
}
