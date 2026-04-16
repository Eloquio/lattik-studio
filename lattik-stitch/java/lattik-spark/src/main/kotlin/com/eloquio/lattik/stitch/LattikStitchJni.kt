package com.eloquio.lattik.stitch

import java.io.File
import java.nio.file.Files

/**
 * JNI bridge to the Rust lattik-stitch engine.
 *
 * Manages stitch sessions: create → hasNext → nextBatch → close.
 * Arrow data crosses the boundary via the C Data Interface (zero-copy).
 */
object LattikStitchJni {
    init {
        loadNativeLibrary()
    }

    private fun loadNativeLibrary() {
        // Strategy 1: Try known absolute path (Docker image layout)
        val knownPaths = listOf(
            "/opt/spark/jars/liblattik_stitch_jni.so",
            "/opt/spark/jars/liblattik_stitch_jni.dylib",
        )
        for (path in knownPaths) {
            val file = java.io.File(path)
            if (file.exists()) {
                System.load(file.absolutePath)
                return
            }
        }

        // Strategy 2: Try java.library.path
        try {
            System.loadLibrary("lattik_stitch_jni")
            return
        } catch (_: UnsatisfiedLinkError) {
            // Fall through
        }

        // Strategy 3: Extract from JAR resources (fat JAR packaging)
        val osName = System.getProperty("os.name").lowercase()
        val libName = when {
            osName.contains("mac") || osName.contains("darwin") -> "liblattik_stitch_jni.dylib"
            osName.contains("win") -> "lattik_stitch_jni.dll"
            else -> "liblattik_stitch_jni.so"
        }

        val resource = LattikStitchJni::class.java.getResourceAsStream("/native/$libName")
            ?: throw RuntimeException(
                "Native library not found. Tried: $knownPaths, java.library.path, JAR:/native/$libName"
            )

        val tempFile = Files.createTempFile("lattik_stitch_jni", ".${libName.substringAfterLast(".")}").toFile()
        tempFile.deleteOnExit()
        resource.use { input ->
            tempFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        System.load(tempFile.absolutePath)
    }

    /**
     * Create a new stitch session from a JSON config.
     * Returns a handle (long) to the Rust-side session.
     */
    @JvmStatic
    external fun createSession(configJson: String): Long

    /**
     * Check if the session has more batches to produce.
     */
    @JvmStatic
    external fun hasNext(handle: Long): Boolean

    /**
     * Export the next RecordBatch via Arrow C Data Interface.
     * Writes to the ArrowSchema and ArrowArray at the given memory addresses.
     * Returns true if a batch was produced, false if exhausted.
     */
    @JvmStatic
    external fun nextBatch(handle: Long, schemaPtr: Long, arrayPtr: Long): Boolean

    /**
     * Export the output schema via Arrow C Data Interface.
     */
    @JvmStatic
    external fun exportSchema(handle: Long, schemaPtr: Long): Boolean

    /**
     * Close and deallocate the session. Must be called exactly once.
     */
    @JvmStatic
    external fun closeSession(handle: Long)
}
