build:
	- rm -rf built
	mkdir built
	jspm bundle-sfx app/main built/app.js
	uglifyjs built/app.js -o built/app.min.js
	html-dist index.html --remove-all --minify --insert app.min.js -o built/index.html
deploy:
	aws s3 sync --profile shitbeards built/ s3://com-shitbeards-quackslock
