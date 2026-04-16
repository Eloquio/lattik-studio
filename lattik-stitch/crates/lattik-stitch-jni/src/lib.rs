//! JNI bridge for lattik-stitch.
//!
//! Exposes the Rust stitch engine to JVM (Spark / Trino) via JNI.
//! The JVM side creates a stitch session, calls nextBatch() to get
//! Arrow RecordBatches via the C Data Interface, and closes the session.
//!
//! Exported JNI functions:
//! - `Java_com_eloquio_lattik_stitch_LattikStitchJni_createSession`
//! - `Java_com_eloquio_lattik_stitch_LattikStitchJni_hasNext`
//! - `Java_com_eloquio_lattik_stitch_LattikStitchJni_nextBatch`
//! - `Java_com_eloquio_lattik_stitch_LattikStitchJni_closeSession`
//! - `Java_com_eloquio_lattik_stitch_LattikStitchJni_exportSchema`

mod session;

use std::panic;
use std::sync::Mutex;

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jlong, JNI_FALSE, JNI_TRUE};
use lattik_stitch_core::error::StitchError;

use session::StitchSession;

/// Catch Rust panics and convert them to a string message.
fn catch_panic<F, T>(f: F) -> std::result::Result<T, String>
where
    F: FnOnce() -> T + panic::UnwindSafe,
{
    panic::catch_unwind(f).map_err(|e| {
        if let Some(s) = e.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = e.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        }
    })
}

/// Global session store. Each session gets a unique ID (the pointer cast to jlong).
/// Sessions are boxed and leaked into raw pointers; the JVM side holds the pointer
/// as a `long` and passes it back on each call.

fn session_from_handle(handle: jlong) -> std::result::Result<&'static Mutex<StitchSession>, String> {
    if handle == 0 {
        return Err("Invalid session handle".to_string());
    }

    Ok(unsafe { &*(handle as *const Mutex<StitchSession>) })
}

/// Create a new stitch session from a JSON config string.
///
/// Config JSON structure:
/// ```json
/// {
///   "load_specs": [
///     {
///       "load_id": "uuid",
///       "path": "s3://bucket/lattik/table/loads/uuid/bucket=0042/",
///       "columns": ["col1", "col2"],
///       "pk_columns": ["user_id"],
///       "format_id": "parquet",
///       "sorted": true,
///       "has_pk_index": false
///     }
///   ],
///   "pk_columns": ["user_id"],
///   "stitcher_id": "naive",
///   "s3_config": {
///     "endpoint": "http://minio:9000",
///     "region": "us-east-1",
///     "access_key_id": "lattik",
///     "secret_access_key": "lattik-local"
///   }
/// }
/// ```
///
/// Returns a jlong handle to the session.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_eloquio_lattik_stitch_LattikStitchJni_createSession(
    mut env: JNIEnv,
    _class: JClass,
    config_json: JString,
) -> jlong {
    let config_str: String = match env.get_string(&config_json) {
        Ok(s) => s.into(),
        Err(e) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("Failed to read config string: {e}"));
            return 0;
        }
    };

    match catch_panic(panic::AssertUnwindSafe(|| StitchSession::from_json(&config_str))) {
        Ok(Ok(session)) => {
            let boxed = Box::new(Mutex::new(session));
            Box::into_raw(boxed) as jlong
        }
        Ok(Err(e)) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("Failed to create session: {e}"));
            0
        }
        Err(panic_msg) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("Rust panic in createSession: {panic_msg}"));
            0
        }
    }
}

/// Check if the session has more batches.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_eloquio_lattik_stitch_LattikStitchJni_hasNext(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jboolean {
    let session = match session_from_handle(handle) {
        Ok(session) => session,
        Err(err) => {
            let _ = env.throw_new("java/lang/RuntimeException", err);
            return JNI_FALSE;
        }
    };

    match catch_panic(panic::AssertUnwindSafe(|| {
        let guard = session
            .lock()
            .map_err(|_| "Session mutex poisoned".to_string())?;
        Ok::<bool, String>(guard.has_next())
    })) {
        Ok(Ok(true)) => JNI_TRUE,
        Ok(Ok(false)) => JNI_FALSE,
        Ok(Err(err)) => {
            let _ = env.throw_new("java/lang/RuntimeException", err);
            JNI_FALSE
        }
        Err(panic_msg) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("Rust panic in hasNext: {panic_msg}"));
            JNI_FALSE
        }
    }
}

/// Get the next stitched RecordBatch as Arrow C Data Interface pointers.
///
/// Returns a jlong array [schema_ptr, array_ptr] that the JVM side uses to
/// import the Arrow data zero-copy. Returns 0 if no more batches.
///
/// The JVM side is responsible for calling ArrowArray.release() when done.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_eloquio_lattik_stitch_LattikStitchJni_nextBatch(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    schema_ptr: jlong,
    array_ptr: jlong,
) -> jboolean {
    let session = match session_from_handle(handle) {
        Ok(session) => session,
        Err(err) => {
            let _ = env.throw_new("java/lang/RuntimeException", err);
            return JNI_FALSE;
        }
    };

    match catch_panic(panic::AssertUnwindSafe(|| {
        let mut guard = session
            .lock()
            .map_err(|_| StitchError::Other(anyhow::anyhow!("Session mutex poisoned")))?;
        guard.next_batch_to_ffi(schema_ptr, array_ptr)
    })) {
        Ok(Ok(true)) => JNI_TRUE,
        Ok(Ok(false)) => JNI_FALSE,
        Ok(Err(e)) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("nextBatch failed: {e}"));
            JNI_FALSE
        }
        Err(panic_msg) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("Rust panic in nextBatch: {panic_msg}"));
            JNI_FALSE
        }
    }
}

/// Export the output schema as Arrow C Data Interface.
/// The JVM side calls this once to get the schema for the ColumnarBatch.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_eloquio_lattik_stitch_LattikStitchJni_exportSchema(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    schema_ptr: jlong,
) -> jboolean {
    let session = match session_from_handle(handle) {
        Ok(session) => session,
        Err(err) => {
            let _ = env.throw_new("java/lang/RuntimeException", err);
            return JNI_FALSE;
        }
    };
    let guard = match session.lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _ = env.throw_new("java/lang/RuntimeException", "Session mutex poisoned");
            return JNI_FALSE;
        }
    };

    match guard.export_schema(schema_ptr) {
        Ok(()) => JNI_TRUE,
        Err(e) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("exportSchema failed: {e}"));
            JNI_FALSE
        }
    }
}

/// Close and deallocate the session.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_eloquio_lattik_stitch_LattikStitchJni_closeSession(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        unsafe {
            let _ = Box::from_raw(handle as *mut Mutex<StitchSession>);
        }
    }
}
