async function prosesPerintah(msg) {
  const teks = msg.text || "";
  const caption = msg.caption || "";
  const fromId = String(msg.from?.id);

  if (fromId !== String(ADMIN_ID)) return;

  // ===== KIRIM FOTO KE WA =====
  if (msg.photo || msg.video || msg.document) {
    const targetCaption = caption.trim();
    const match = targetCaption.match(/^\/?#?(\d+)/);

    if (!match) {
      await kirimTeks("❌ Tambahkan caption nomor chat.\nContoh: kirim foto dengan caption <code>/3</code>");
      return;
    }

    const id = parseInt(match[1]);
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat #${id} tidak ditemukan.`);
      return;
    }

    try {
      let fileId, mediaType, fileName;

      if (msg.photo) {
        // Ambil foto resolusi tertinggi
        fileId = msg.photo[msg.photo.length - 1].file_id;
        mediaType = "image";
      } else if (msg.video) {
        fileId = msg.video.file_id;
        mediaType = "video";
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name || "file";
        mediaType = "document";
      }

      // Download file dari Telegram
      const fileInfoRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfoRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
      const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(fileRes.data);

      // Siapkan pesan WA
      let pesanWA;
      const pesanTeks = targetCaption.replace(/^\/?#?\d+\s*/, "").trim();

      if (mediaType === "image") {
        pesanWA = {
          image: buffer,
          caption: pesanTeks || "",
        };
      } else if (mediaType === "video") {
        pesanWA = {
          video: buffer,
          caption: pesanTeks || "",
        };
      } else {
        pesanWA = {
          document: buffer,
          fileName: fileName,
          caption: pesanTeks || "",
        };
      }

      queue.tambahKeAntrian(chat.waId, chat.jid, pesanTeks, pesanWA);
      await kirimTeks(`✅ Media ke <b>${chat.nama}</b> (#${id}) masuk antrian.`);
      logger.info("Bot-Bridge", `Media dari Telegram ke #${id} masuk antrian`);
    } catch (err) {
      await kirimTeks(`❌ Gagal proses media: ${err.message}`);
      logger.error("Bot-Bridge", `Gagal proses media: ${err.message}`);
    }
    return;
  }

  // Format baru: /1 pesanmu atau /#1 pesanmu
  if (teks.match(/^\/#?\d+/)) {
    const spasi = teks.indexOf(" ");
    if (spasi === -1) {
      await kirimTeks("❌ Format: /1 pesanmu");
      return;
    }
    const idStr = teks.slice(1, spasi).replace("#", "");
    const id = parseInt(idStr);
    const pesan = teks.slice(spasi + 1).trim();
    const chat = chatLog[id];

    if (!chat) {
      await kirimTeks(`❌ Chat #${id} tidak ditemukan.`);
      return;
    }

    queue.tambahKeAntrian(chat.waId, chat.jid, pesan);
    await kirimTeks(`✅ Pesan ke <b>${chat.nama}</b> (#${id}) masuk antrian.`);
    logger.info("Bot-Bridge", `Balas #${id} ke ${chat.nama} masuk antrian`);
  }

  // /ke nomor pesan
  else if (teks.startsWith("/ke ")) {
    const bagian = teks.replace("/ke ", "").trim().split(" ");
    const nomor = bagian[0];
    const pesan = bagian.slice(1).join(" ");
    if (!nomor || !pesan) {
      await kirimTeks("❌ Format: /ke 628xxx pesanmu");
      return;
    }
    const waIds = waManager.getAllIds();
    if (waIds.length === 0) {
      await kirimTeks("❌ Tidak ada WA yang terhubung.");
      return;
    }
    const jid = nomor.includes("@") ? nomor : `${nomor}@s.whatsapp.net`;
    queue.tambahKeAntrian(waIds[0], jid, pesan);
    await kirimTeks(`✅ Pesan ke ${nomor} masuk antrian.`);
  }

  // /teruskanunread waId
  else if (teks.startsWith("/teruskanunread ")) {
    const waId = teks.replace("/teruskanunread ", "").trim();
    const unreadChats = pendingUnread[waId];

    if (!unreadChats || unreadChats.length === 0) {
      await kirimTeks(`❌ Tidak ada unread pending untuk ${waId}.`);
      return;
    }

    await kirimTeks(`⏳ Meneruskan pesan unread dari ${waId}...`);

    for (const chat of unreadChats) {
      chatCounter++;
      const id = chatCounter;
      chatLog[id] = { waId, jid: chat.jid, nama: chat.name, waktu: Date.now() };
      saveChatLog();

      await kirimTeks(
        `📬 <b>[#${id}] Unread - ${waId}</b>\n` +
        `👤 <b>${chat.name}</b>\n` +
        `📞 <code>${chat.jid.replace(/@.*/, "")}</code>\n` +
        `📨 ${chat.unreadCount} pesan belum dibaca\n\n` +
        `<i>Balas: /${id} pesanmu</i>`
      );
    }

    delete pendingUnread[waId];
  }

  // /antrian
  else if (teks === "/antrian") {
    const status = queue.getStatus();
    await kirimTeks(
      `📋 <b>Status Antrian</b>\n\n` +
      `Pesan menunggu: ${status.panjangAntrian}\n` +
      `Sedang proses: ${status.sedangProses ? "Ya" : "Tidak"}`
    );
  }

  // /status
  else if (teks === "/status") {
    const waStatus = waManager.getStatus();
    const daftar = Object.entries(waStatus)
      .map(([id, s]) => `- ${id}: ${s.status === "connected" ? "✅" : "❌"} ${s.jid?.replace(/@.*/, "") || ""}`)
      .join("\n") || "Tidak ada WA terhubung";

    await kirimTeks(
      `ℹ️ <b>Status WA Bridge</b>\n\n` +
      `${daftar}\n\n` +
      `<b>Perintah:</b>\n` +
      `/id pesan - Balas ke chat tertentu\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n` +
      `/antrian - Cek status antrian\n` +
      `/status - Cek status WA`
    );
  }

  // /start
  else if (teks === "/start") {
    await kirimTeks(
      `👋 <b>WA Bridge Bot aktif!</b>\n\n` +
      `<b>Perintah:</b>\n` +
      `/id pesan - Balas ke chat tertentu\n` +
      `/ke nomor pesan - Kirim ke nomor baru\n` +
      `/antrian - Cek status antrian\n` +
      `/status - Cek status WA\n\n` +
      `<b>Kirim media:</b>\n` +
      `Kirim foto/video/dokumen dengan caption /id`
    );
  }
}

