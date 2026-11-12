use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSourceInfo {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub width: i32,
    pub height: i32,
}

#[cfg(target_os = "windows")]
mod win {
    use super::CaptureSourceInfo;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits,
        GetMonitorInfoW, HALFTONE, HDC, HMONITOR, MONITORINFOEXW, ReleaseDC, SRCCOPY, SelectObject,
        SetStretchBltMode, StretchBlt,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClientRect, GetDesktopWindow, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, IsIconic, IsWindowVisible,
    };

    #[link(name = "user32")]
    unsafe extern "system" {
        fn PrintWindow(hwnd: HWND, hdcblt: HDC, nflags: u32) -> BOOL;
    }

    #[derive(Clone)]
    struct MonitorRect {
        name: String,
        rect: RECT,
    }

    unsafe extern "system" fn enum_monitor_cb(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let vec = unsafe { &mut *(lparam as *mut Vec<MonitorRect>) };
        let mut info: MONITORINFOEXW = unsafe { std::mem::zeroed() };
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _) } != 0 {
            let end = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let name = String::from_utf16_lossy(&info.szDevice[..end]);
            vec.push(MonitorRect {
                name,
                rect: info.monitorInfo.rcMonitor,
            });
        }
        TRUE
    }

    unsafe extern "system" fn enum_window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let vec = unsafe { &mut *(lparam as *mut Vec<(usize, String, i32, i32)>) };
        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
            return TRUE;
        }
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return TRUE;
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if copied <= 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&buf[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() || title == "Program Manager" {
            return TRUE;
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return TRUE;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w < 120 || h < 80 {
            return TRUE;
        }
        vec.push((hwnd as usize, title, w, h));
        TRUE
    }

    pub fn list_sources() -> Vec<CaptureSourceInfo> {
        let mut out = Vec::new();
        let mut monitors: Vec<MonitorRect> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(enum_monitor_cb),
                &mut monitors as *mut _ as LPARAM,
            );
        }
        for (idx, m) in monitors.into_iter().enumerate() {
            let w = (m.rect.right - m.rect.left).max(1);
            let h = (m.rect.bottom - m.rect.top).max(1);
            out.push(CaptureSourceInfo {
                id: format!("mon:{idx}"),
                kind: "monitor",
                title: format!("Display {} ({}×{} · {})", idx + 1, w, h, m.name),
                width: w,
                height: h,
            });
        }

        let mut windows: Vec<(usize, String, i32, i32)> = Vec::new();
        unsafe {
            EnumWindows(Some(enum_window_cb), &mut windows as *mut _ as LPARAM);
        }
        for (hwnd_val, title, w, h) in windows.into_iter().take(24) {
            out.push(CaptureSourceInfo {
                id: format!("win:{hwnd_val}"),
                kind: "window",
                title,
                width: w,
                height: h,
            });
        }
        out
    }

    /// Captures a live monitor or application window via Win32 GDI (`StretchBlt` / `PrintWindow`)
    /// into an uncompressed 32-bpp BMP byte vector ready for canvas/WebRTC streaming.
    pub fn capture_bmp(source_id: &str, max_width: i32) -> Result<Vec<u8>, String> {
        let max_width = max_width.clamp(320, 3840);
        if let Some(mon_idx_str) = source_id.strip_prefix("mon:") {
            let idx: usize = mon_idx_str.parse().map_err(|_| "Invalid monitor index")?;
            let mut monitors: Vec<MonitorRect> = Vec::new();
            unsafe {
                EnumDisplayMonitors(
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    Some(enum_monitor_cb),
                    &mut monitors as *mut _ as LPARAM,
                );
            }
            let mon = monitors
                .get(idx)
                .ok_or_else(|| format!("Monitor {idx} not found"))?;
            let src_w = (mon.rect.right - mon.rect.left).max(1);
            let src_h = (mon.rect.bottom - mon.rect.top).max(1);
            let (dst_w, dst_h) = scale_dims(src_w, src_h, max_width);
            unsafe {
                let desk_hwnd = GetDesktopWindow();
                let src_dc = GetDC(desk_hwnd);
                if src_dc.is_null() {
                    return Err("GetDC(desktop) failed".into());
                }
                let res = capture_dc_region_to_bmp(
                    src_dc,
                    mon.rect.left,
                    mon.rect.top,
                    src_w,
                    src_h,
                    dst_w,
                    dst_h,
                    None,
                );
                ReleaseDC(desk_hwnd, src_dc);
                return res;
            }
        }

        if let Some(win_id_str) = source_id.strip_prefix("win:") {
            let raw_hwnd: usize = win_id_str.parse().map_err(|_| "Invalid window handle")?;
            let hwnd = raw_hwnd as HWND;
            if unsafe { IsWindowVisible(hwnd) } == 0 {
                return Err("Selected window is no longer visible".into());
            }
            let mut rect: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut rect) };
            let src_w = (rect.right - rect.left).max(1);
            let src_h = (rect.bottom - rect.top).max(1);
            let (dst_w, dst_h) = scale_dims(src_w, src_h, max_width);
            unsafe {
                let src_dc = GetDC(hwnd);
                if src_dc.is_null() {
                    return Err("GetDC(window) failed".into());
                }
                let res =
                    capture_dc_region_to_bmp(src_dc, 0, 0, src_w, src_h, dst_w, dst_h, Some(hwnd));
                ReleaseDC(hwnd, src_dc);
                return res;
            }
        }

        Err(format!("Unsupported capture source id: {source_id}"))
    }

    fn scale_dims(src_w: i32, src_h: i32, max_w: i32) -> (i32, i32) {
        if src_w <= max_w {
            (src_w.max(2), src_h.max(2))
        } else {
            let dst_h = ((src_h as i64 * max_w as i64) / src_w as i64).max(2) as i32;
            (max_w, dst_h)
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn capture_dc_region_to_bmp(
        src_dc: HDC,
        src_x: i32,
        src_y: i32,
        src_w: i32,
        src_h: i32,
        dst_w: i32,
        dst_h: i32,
        print_hwnd: Option<HWND>,
    ) -> Result<Vec<u8>, String> {
        let mem_dc = unsafe { CreateCompatibleDC(src_dc) };
        if mem_dc.is_null() {
            return Err("CreateCompatibleDC failed".into());
        }

        let (work_dc, work_bmp) = if let Some(hwnd) = print_hwnd {
            let full_dc = unsafe { CreateCompatibleDC(src_dc) };
            let full_bmp = unsafe { CreateCompatibleBitmap(src_dc, src_w, src_h) };
            let old_f = unsafe { SelectObject(full_dc, full_bmp) };
            let printed = unsafe { PrintWindow(hwnd, full_dc, 2) };
            if printed == 0 {
                let _ = unsafe { BitBlt(full_dc, 0, 0, src_w, src_h, src_dc, 0, 0, SRCCOPY) };
            }
            unsafe { SelectObject(full_dc, old_f) };
            (full_dc, Some(full_bmp))
        } else {
            (src_dc, None)
        };

        let dst_bmp = unsafe { CreateCompatibleBitmap(src_dc, dst_w, dst_h) };
        if dst_bmp.is_null() {
            if let Some(b) = work_bmp {
                unsafe {
                    DeleteObject(b);
                    DeleteDC(work_dc);
                }
            }
            unsafe { DeleteDC(mem_dc) };
            return Err("CreateCompatibleBitmap failed".into());
        }

        let old_dst = unsafe { SelectObject(mem_dc, dst_bmp) };
        unsafe { SetStretchBltMode(mem_dc, HALFTONE) };

        let blt_ok = if let Some(wbmp) = work_bmp {
            let tmp_dc = unsafe { CreateCompatibleDC(src_dc) };
            let old_tmp = unsafe { SelectObject(tmp_dc, wbmp) };
            let ok = unsafe {
                StretchBlt(
                    mem_dc, 0, 0, dst_w, dst_h, tmp_dc, 0, 0, src_w, src_h, SRCCOPY,
                )
            };
            unsafe {
                SelectObject(tmp_dc, old_tmp);
                DeleteDC(tmp_dc);
            }
            ok
        } else {
            unsafe {
                StretchBlt(
                    mem_dc, 0, 0, dst_w, dst_h, work_dc, src_x, src_y, src_w, src_h, SRCCOPY,
                )
            }
        };

        let pixel_bytes = (dst_w as usize) * (dst_h as usize) * 4;
        let mut pixels = vec![0u8; pixel_bytes];
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = dst_w;
        bmi.bmiHeader.biHeight = -dst_h; // top-down DIB
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let scanlines = if blt_ok != 0 {
            unsafe {
                GetDIBits(
                    mem_dc,
                    dst_bmp,
                    0,
                    dst_h as u32,
                    pixels.as_mut_ptr() as *mut _,
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            }
        } else {
            0
        };

        unsafe {
            SelectObject(mem_dc, old_dst);
            DeleteObject(dst_bmp);
            DeleteDC(mem_dc);
            if let Some(b) = work_bmp {
                DeleteObject(b);
                DeleteDC(work_dc);
            }
        }

        if scanlines == 0 {
            return Err("GetDIBits failed capturing screen pixels".into());
        }

        // Force alpha=255 cleanly
        let (rgba_chunks, _) = pixels.as_chunks_mut::<4>();
        for px in rgba_chunks {
            px[3] = 255;
        }

        // Wrap in standard BMP header (14-byte BITMAPFILEHEADER + 40-byte BITMAPINFOHEADER)
        let header_total = 54u32;
        let file_size = header_total + pixel_bytes as u32;
        let mut bmp = Vec::with_capacity(file_size as usize);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&file_size.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&header_total.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&dst_w.to_le_bytes());
        bmp.extend_from_slice(&(-dst_h).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&32u16.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
        bmp.extend_from_slice(&2835i32.to_le_bytes());
        bmp.extend_from_slice(&2835i32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&pixels);
        Ok(bmp)
    }
}

pub fn list_capture_sources() -> Vec<CaptureSourceInfo> {
    #[cfg(target_os = "windows")]
    {
        win::list_sources()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

pub fn capture_source_bmp(source_id: &str, max_width: i32) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        win::capture_bmp(source_id, max_width)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (source_id, max_width);
        Err("Native screen capture is supported on Windows".into())
    }
}
