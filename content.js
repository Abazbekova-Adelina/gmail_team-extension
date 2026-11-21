function createChat() {
  if (document.getElementById("team-chat")) return;

  const panel = document.createElement("div");
  panel.id = "team-chat";

  panel.innerHTML = `
    <h3>Team Discussion</h3>
    <div id="team-messages">
      <p><b>Alex:</b> Should we schedule a call?</p>
      <p><b>Adelina:</b> Yes, Monday sounds good!</p>
    </div>
    <div class="team-input">
      <input id="team-message-input"
             placeholder="Write a message..." />
      <button id="team-send">Send</button>
    </div>
  `;

  document.body.appendChild(panel);

  const input = panel.querySelector("#team-message-input");
  const messages = panel.querySelector("#team-messages");

  panel.querySelector("#team-send").addEventListener("click", () => {
    const message = input.value.trim();
    if (!message) return;

    const line = document.createElement("p");
    line.textContent = "You: " + message;
    messages.appendChild(line);
    input.value = "";
  });
}

createChat();