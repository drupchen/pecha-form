import flet as ft
from pathlib import Path

def main(page: ft.Page):
    def btn_click(e):
        if not url_input.value:
            output_text.value = "Please enter a URL"
        else:
            result = pecha_form(url_input.value)
            write_output(result)
            output_text.value = f"Output written to {output_file}"
        page.update()

    def write_output(content):
        output_dir = Path("output")
        output_dir.mkdir(exist_ok=True)
        global output_file
        output_file = output_dir / "output.txt"
        output_file.write_text(content)

    def pecha_form(url):
        # This is a placeholder function. Replace with your actual implementation.
        return f"Processed URL: {url}"

    url_input = ft.TextField(label="Enter URL")
    submit_btn = ft.ElevatedButton("Submit", on_click=btn_click)
    output_text = ft.Text()

    page.add(url_input, submit_btn, output_text)

ft.app(target=main)