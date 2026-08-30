package com.glossa.dev

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // NOTE: the stock template calls enableEdgeToEdge() here. That forces
    // Android 15+ edge-to-edge, which silently disables adjustResize — the
    // keyboard then floats OVER the composer instead of shrinking the
    // window. Glossa is a chat-style app and needs the classic resize.
    super.onCreate(savedInstanceState)
  }
}
