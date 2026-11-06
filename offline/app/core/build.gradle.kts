plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "xyz.prawl.core"
    compileSdk = 36
    defaultConfig {
        minSdk = 31
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.all { t ->
            // Real phone vectors are read in place (read-only) from the research tree: raw/ is two levels up.
            t.systemProperty("prawl.raw", rootProject.layout.projectDirectory.dir("../..").asFile.canonicalPath)
            t.systemProperty("prawl.assets", layout.projectDirectory.dir("src/main/assets").asFile.canonicalPath)
            // blst JNI shim built for the laptop JVM (copied from raw/v3/deposit_proofs/java/native/lib/linux-x86_64)
            t.systemProperty("prawl.native", layout.projectDirectory.file("src/test/native/linux-x86_64/libprawlbls.so").asFile.canonicalPath)
            t.testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
        }
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
}
