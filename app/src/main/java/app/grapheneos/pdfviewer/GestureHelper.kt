package app.grapheneos.pdfviewer

import android.annotation.SuppressLint
import android.content.Context
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View

/*
 * The GestureHelper present a simple gesture api for the PdfViewer
 */

object GestureHelper {
    interface GestureListener {
        fun onTapUp(): Boolean
        fun onZoom(scaleFactor: Float, focusX: Float, focusY: Float)
        fun onZoomEnd()
    }

    @SuppressLint("ClickableViewAccessibility")
    fun attach(context: Context, gestureView: View, listener: GestureListener) {
        val scaleDetector = ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    listener.onZoom(detector.scaleFactor, detector.focusX, detector.focusY)
                    return true
                }

                override fun onScaleEnd(detector: ScaleGestureDetector) {
                    listener.onZoomEnd()
                }
            })

        val detector = GestureDetector(
            context,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onSingleTapUp(e: MotionEvent): Boolean {
                    return listener.onTapUp()
                }
            })

        gestureView.setOnTouchListener { _, event ->
            detector.onTouchEvent(event)
            scaleDetector.onTouchEvent(event)

            false
        }
    }
}
