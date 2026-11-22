package de.sitemate.demo;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.widget.Toast;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

@CapacitorPlugin(name = "ProjectDownloads")
public class ProjectDownloads extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        Uri file = Uri.parse(call.getString("url", ""));
        Uri app = Uri.parse(bridge.getAppUrl());
        String name = call.getString("filename", "");
        if (!app.getScheme().equals(file.getScheme()) || !app.getAuthority().equals(file.getAuthority())
                || file.getPath() == null || !file.getPath().startsWith("/api/sm/projects/")
                || name.isEmpty() || name.contains("/") || name.contains("\\")) {
            call.reject("Invalid project download.");
            return;
        }
        String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "application/octet-stream";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime).putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, picker, "destinationChosen");
            return;
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        try {
            Uri destination = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new IOException("Could not create the file in Downloads.");
            write(call, destination, true);
        } catch (IOException | RuntimeException error) {
            call.reject("Could not save the file in Downloads.", error);
        }
    }

    @ActivityCallback
    private void destinationChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent intent = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || intent == null || intent.getData() == null) {
            call.resolve();
            return;
        }
        bridge.execute(() -> write(call, intent.getData(), false));
    }

    private void write(PluginCall call, Uri destination, boolean pending) {
        HttpURLConnection connection = null;
        try {
            String url = call.getString("url");
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IOException("Project file unavailable.");
            try (InputStream in = connection.getInputStream();
                 OutputStream out = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (out == null) throw new IOException("Could not open the destination.");
                byte[] buffer = new byte[16384];
                int length;
                while ((length = in.read(buffer)) != -1) out.write(buffer, 0, length);
            }
            if (pending && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(destination, values, null, null);
            }
            getActivity().runOnUiThread(() -> Toast.makeText(getContext(),
                    getContext().getString(R.string.download_saved, call.getString("filename")), Toast.LENGTH_SHORT).show());
            call.resolve();
        } catch (IOException | RuntimeException error) {
            if (pending) getContext().getContentResolver().delete(destination, null, null);
            call.reject("Could not save the project file.", error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
