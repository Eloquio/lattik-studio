package com.eloquio.lattik.stitch;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;

/**
 * JNI bridge to the Rust lattik-stitch engine.
 * Java version of the Kotlin class in lattik-spark — same package and
 * method signatures so the Rust JNI symbols match.
 */
public final class LattikStitchJni {
    static {
        loadNativeLibrary();
    }

    private static void loadNativeLibrary() {
        // Strategy 1: Try known absolute paths (Docker/plugin layout)
        String[] knownPaths = {
            "/usr/lib/trino/plugin/lattik/liblattik_stitch_jni.so",
            "/opt/spark/jars/liblattik_stitch_jni.so",
        };
        for (String path : knownPaths) {
            File file = new File(path);
            if (file.exists()) {
                System.load(file.getAbsolutePath());
                return;
            }
        }

        // Strategy 2: Try java.library.path
        try {
            System.loadLibrary("lattik_stitch_jni");
            return;
        } catch (UnsatisfiedLinkError ignored) {
        }

        // Strategy 3: Extract from JAR
        String osName = System.getProperty("os.name").toLowerCase();
        String libName = osName.contains("mac") || osName.contains("darwin")
                ? "liblattik_stitch_jni.dylib"
                : "liblattik_stitch_jni.so";

        try (InputStream in = LattikStitchJni.class.getResourceAsStream("/native/" + libName)) {
            if (in == null) {
                throw new RuntimeException("Native library not found in JAR: native/" + libName);
            }
            File tempFile = Files.createTempFile("lattik_stitch_jni", libName.substring(libName.lastIndexOf('.'))).toFile();
            tempFile.deleteOnExit();
            Files.copy(in, tempFile.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            System.load(tempFile.getAbsolutePath());
        } catch (Exception e) {
            throw new RuntimeException("Failed to load native library", e);
        }
    }

    public static native long createSession(String configJson);
    public static native boolean hasNext(long handle);
    public static native boolean nextBatch(long handle, long schemaPtr, long arrayPtr);
    public static native boolean exportSchema(long handle, long schemaPtr);
    public static native void closeSession(long handle);
}
