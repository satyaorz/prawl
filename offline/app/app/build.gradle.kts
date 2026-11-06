plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Build-time config (override with -Pprawl.site=https://my-wallet.vercel.app etc.)
val site: String = (findProperty("prawl.site") as String?) ?: "https://<site>"
// Escrow for NEW coins: v3.1 (adds private load, shield cash-out, refresh). v3 coins stay spendable (see core Escrows.PRODUCT).
val escrow = "0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779"
val chainId = "11155111"
// SHA-256 of keystore/prawl-debug.keystore's certificate: the same key that signed the Java harness, so the
// attestation policy (package + signing cert) recognises keys made by either DEBUG app. That keystore is in the repo with the
// well-known password "android": its digest must NEVER be trusted by a release build (audit F-11).
val debugCertSha256 = "e6e0daae1031f70e5a267a383878ac564a935106f75600310feda6bf1ea92eaf"
// The production signing certificate's SHA-256 (64 lowercase hex): -Pprawl.release.certSha256=... The default is a PLACEHOLDER that matches
// no real certificate, so an unconfigured release build trusts no key at all (fail safe) instead of the debug certificate.
val releaseCertSha256: String = ((findProperty("prawl.release.certSha256") as String?) ?: "0".repeat(64)).lowercase()
val releaseAllowedApps = "xyz.prawl.offline:$releaseCertSha256"

android {
    namespace = "xyz.prawl.offline"
    compileSdk = 36

    defaultConfig {
        applicationId = "xyz.prawl.offline"
        minSdk = 31
        targetSdk = 36
        versionCode = 300
        versionName = "0.3.0"
        buildConfigField("String", "HANDOFF_SITE", "\"$site\"")
        buildConfigField("String", "ESCROW", "\"$escrow\"")   // default escrow for new coins
        buildConfigField("String", "CHAIN_ID", "\"$chainId\"")
        // Light-client sync (deposit proofs). Beacon LC routes: Nimbus; independent checkpoint checkers; EL eth_getProof.
        buildConfigField("String", "BEACON", "\"http://unstable.sepolia.beacon-api.nimbus.team\"")
        buildConfigField("String", "BEACON_CHECKERS", "\"https://lodestar-sepolia.chainsafe.io,https://ethereum-sepolia-beacon-api.publicnode.com\"")
        buildConfigField("String", "EL_RPC", "\"https://0xrpc.io/sep\"")
        buildConfigField("String", "EL_RPC2", "\"https://sepolia.rpc.thirdweb.com\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("keystore/prawl-debug.keystore")
            storePassword = "android"
            keyAlias = "debug"
            keyPassword = "android"
        }
    }

    flavorDimensions += "id"
    productFlavors {
        // The product app.
        create("prawl") {
            dimension = "id"
            applicationId = "xyz.prawl.offline"
        }
        // Drop-in replacement for the Java harness on the test phones: same package (xyz.prawl.otktest) and signing
        // key, so the old harness and this app accept each other's attested keys, and the coordinator's scripts reach
        // the harness mode at xyz.prawl.otktest/xyz.prawl.otktest.Wallet3Activity (an activity-alias, debug only).
        create("compat") {
            dimension = "id"
            applicationId = "xyz.prawl.otktest"
            versionNameSuffix = "-compat"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            // Apps whose keys this wallet accepts: "package:certSha256,…". Debug: the app and the Java harness, both debug-signed.
            buildConfigField("String", "ALLOWED_APPS", "\"xyz.prawl.offline:$debugCertSha256,xyz.prawl.otktest:$debugCertSha256\"")
        }
        release {
            isMinifyEnabled = false
            // Release: ONLY the production certificate (placeholder until -Pprawl.release.certSha256 is given); never the debug one.
            buildConfigField("String", "ALLOWED_APPS", "\"$releaseAllowedApps\"")
            // no signing config: release builds must be signed with the production key
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // libprawlbls.so stored uncompressed and 16 KB page-aligned (AGP default for minSdk >= 23)
        jniLibs.useLegacyPackaging = false
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("prawl.screenshots", rootProject.layout.projectDirectory.dir("docs/screenshots").asFile.canonicalPath)
            it.systemProperty("prawl.raw", rootProject.layout.projectDirectory.dir("../..").asFile.canonicalPath)
        }
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.zxing.core)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    // JVM screenshots of the screens (Robolectric native graphics + Roborazzi), see ScreenshotTest
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.androidx.test.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

// Fails every release build whose allow-list holds the public debug certificate, or whose digest is not 64 lowercase hex (audit F-11).
val verifyReleaseAllowedApps = tasks.register("verifyReleaseAllowedApps") {
    doLast {
        if (!Regex("[0-9a-f]{64}").matches(releaseCertSha256)) throw GradleException("prawl.release.certSha256 must be 64 lowercase hex digits (got '$releaseCertSha256')")
        if (releaseAllowedApps.contains(debugCertSha256, ignoreCase = true) || releaseCertSha256 == debugCertSha256)
            throw GradleException("The release ALLOWED_APPS contains the public DEBUG signing certificate ($debugCertSha256). " +
                "Anyone can sign an app with it (keystore password 'android'), so its hardware keys would pass the 'created by an allowed app' rule.")
    }
}
tasks.matching { it.name.startsWith("generate") && it.name.endsWith("ReleaseBuildConfig") }.configureEach { dependsOn(verifyReleaseAllowedApps) }
